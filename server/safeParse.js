import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LIMITS, PROJECT_ROOT } from './config.js';
import { complexityViolation } from './parseGuard.js';

const WORKER_PATH = path.join(PROJECT_ROOT, 'server', 'parseWorker.js');
const BULK_TIMEOUT_MS = 2500;
const REFUSE_AFTER_STOP_MS = 2000;
const START_TIMEOUT_MS = 15000;
const RESPAWN_DELAY_MS = 100;
const PING_INTERVAL_MS = 5000;
const RETIRE_GRACE_MS = 2000;
const REGISTRY_KEY = Symbol.for('hmr-live.parse-worker-registry');
const CANARY_SOURCE = 'export default 1;';
const TOO_LARGE = { crashed: true, transient: false, reason: 'too_large' };
const SHUTTING_DOWN = { crashed: true, transient: true, reason: 'shutting_down' };

function createLane(timeoutMs) {
  return { worker: null, queue: Promise.resolve(), timeoutMs };
}

const lanes = { interactive: createLane(LIMITS.parseTimeoutMs), bulk: createLane(BULK_TIMEOUT_MS) };
const registry = (globalThis[REGISTRY_KEY] ??= { current: null, children: new Set(), exitHookInstalled: false });
const instanceId = randomUUID();
let nextRequestId = 0;
let stoppedAt = 0;

function isCurrentInstance() {
  return registry.current === instanceId;
}

function retire(child) {
  child.retired = true;
  registry.children.delete(child);
  if (child.connected) child.send({ retire: true }, () => {});
  setTimeout(() => child.kill(), RETIRE_GRACE_MS).unref();
}

function claimRegistry() {
  for (const child of [...registry.children]) if (child.owner !== instanceId) retire(child);
  registry.current = instanceId;
  if (registry.exitHookInstalled) return;
  registry.exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of registry.children) child.kill();
  });
}

claimRegistry();

const heartbeat = setInterval(() => {
  if (!isCurrentInstance()) {
    clearInterval(heartbeat);
    return;
  }
  if (isStopping()) return;
  for (const lane of Object.values(lanes)) if (lane.worker?.connected) lane.worker.send({ ping: true }, () => {});
}, PING_INTERVAL_MS);
heartbeat.unref();

function startWorker(lane) {
  const child = fork(WORKER_PATH, [], {
    execArgv: [`--max-old-space-size=${LIMITS.parseWorkerHeapMb}`],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  child.owner = instanceId;
  registry.children.add(child);
  child.unref();
  child.channel?.unref();
  child.on('error', () => {});
  child.on('exit', (code) => {
    registry.children.delete(child);
    if (lane.worker === child) lane.worker = null;
    if (code !== 0 && child.wasReady && !child.retired && isCurrentInstance() && !isStopping()) respawnLater(lane);
  });
  child.ready = new Promise((resolve) => {
    const onReady = (message) => {
      if (message?.ready !== true) return;
      child.off('message', onReady);
      child.wasReady = true;
      resolve(true);
    };
    child.on('message', onReady);
    child.once('exit', () => resolve(false));
  });
  return child;
}

function isStopping() {
  return Date.now() - stoppedAt < REFUSE_AFTER_STOP_MS;
}

function respawnLater(lane) {
  const timer = setTimeout(() => {
    if (lane.worker === null && isCurrentInstance() && !isStopping()) lane.worker = startWorker(lane);
  }, RESPAWN_DELAY_MS);
  timer.unref();
}

function discard(lane, child) {
  if (lane.worker === child) lane.worker = null;
  child.kill();
}

async function runRequest(lane, request, isRetry = false) {
  lane.worker ??= startWorker(lane);
  const child = lane.worker;
  const startTimer = { handle: null };
  const started = await Promise.race([child.ready, new Promise((resolve) => { startTimer.handle = setTimeout(() => resolve(false), START_TIMEOUT_MS); })]);
  clearTimeout(startTimer.handle);
  if (!started) {
    discard(lane, child);
    return isRetry ? { crashed: true, reason: 'crashed' } : runRequest(lane, request, true);
  }
  return new Promise((resolve) => {
    const detach = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    const finish = (result) => {
      detach();
      resolve(result);
    };
    const onMessage = (message) => {
      if (message.id === request.id) finish(message.result);
    };
    const onExit = (code) => {
      if (code === 0 && !isRetry) {
        detach();
        runRequest(lane, request, true).then(resolve);
        return;
      }
      finish({ crashed: true, reason: 'crashed' });
    };
    const timer = setTimeout(() => {
      discard(lane, child);
      finish({ crashed: true, reason: 'timeout' });
    }, lane.timeoutMs);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.send(request, (error) => {
      if (!error) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      discard(lane, child);
      if (isRetry) resolve({ crashed: true, reason: 'crashed' });
      else runRequest(lane, request, true).then(resolve);
    });
  });
}

async function runVerified(lane, request) {
  const result = await runRequest(lane, request);
  if (!result.crashed) return result;
  if (result.reason !== 'crashed' && result.reason !== 'timeout') return { transient: false, ...result };
  const canary = await runRequest(lane, { id: (nextRequestId += 1), operation: 'check', code: CANARY_SOURCE, language: 'tsx' });
  if (canary.ok !== true) return { ...result, transient: true };
  const second = await runRequest(lane, { ...request, id: (nextRequestId += 1) });
  if (!second.crashed) return second;
  return { transient: false, ...second };
}

export function parseSafely(code, language, operation = 'check', laneName = 'interactive') {
  if (isStopping()) return Promise.resolve(SHUTTING_DOWN);
  if (code.length > LIMITS.maxParseChars) return Promise.resolve(TOO_LARGE);
  const violation = complexityViolation(code);
  if (violation !== null) return Promise.resolve({ crashed: true, transient: false, reason: violation });
  const lane = lanes[laneName];
  const run = lane.queue.then(() => runVerified(lane, { id: (nextRequestId += 1), operation, code, language }));
  lane.queue = run;
  return run;
}

export async function warmParseWorker() {
  if (isStopping()) return;
  const workers = Object.values(lanes).map((lane) => (lane.worker ??= startWorker(lane)));
  await Promise.all(workers.map((worker) => worker.ready));
}

export function stopParseWorker() {
  stoppedAt = Date.now();
  for (const lane of Object.values(lanes)) {
    lane.worker?.kill();
    lane.worker = null;
  }
  for (const child of [...registry.children]) if (child.owner === instanceId) child.kill();
}
