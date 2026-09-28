import { fork } from 'node:child_process';
import path from 'node:path';
import { LIMITS, PROJECT_ROOT } from './config.js';

const WORKER_PATH = path.join(PROJECT_ROOT, 'server', 'parseWorker.js');
const UNPARSEABLE_TOO_LARGE = { crashed: true, reason: 'too_large' };
let worker = null;
let queue = Promise.resolve();
let nextRequestId = 0;

function startWorker() {
  const child = fork(WORKER_PATH, [], {
    execArgv: [`--max-old-space-size=${LIMITS.parseWorkerHeapMb}`],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  child.unref();
  child.channel?.unref();
  child.on('error', () => {});
  child.on('exit', () => {
    if (worker === child) worker = null;
  });
  return child;
}

function discard(child) {
  if (worker === child) worker = null;
  child.kill();
}

function runRequest(request, isRetry = false) {
  worker ??= startWorker();
  const child = worker;
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      resolve(result);
    };
    const onMessage = (message) => {
      if (message.id === request.id) finish(message.result);
    };
    const onExit = () => finish({ crashed: true, reason: 'crashed' });
    const timer = setTimeout(() => {
      discard(child);
      finish({ crashed: true, reason: 'timeout' });
    }, LIMITS.parseTimeoutMs);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.send(request, (error) => {
      if (!error) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      discard(child);
      if (isRetry) resolve({ crashed: true, reason: 'crashed' });
      else runRequest(request, true).then(resolve);
    });
  });
}

export function parseSafely(code, language, operation = 'check') {
  if (code.length > LIMITS.maxParseChars) return Promise.resolve(UNPARSEABLE_TOO_LARGE);
  const run = queue.then(() => runRequest({ id: (nextRequestId += 1), operation, code, language }));
  queue = run;
  return run;
}

export function stopParseWorker() {
  worker?.kill();
  worker = null;
}
