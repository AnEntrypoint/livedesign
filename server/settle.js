import { APP_RELOAD_PATH, LIMITS } from './config.js';
import { checkFile } from './diagnostics.js';
import { installMissingFromErrors, registerResolvable } from './packages.js';
import * as status from './status.js';

const CONTROL_FRAME_NAME = 'hmr-live-frame';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const checkTickets = new Map();
const CHECK_ATTEMPTS = 4;
const RETRY_AFTER_CHECK_FAILURE_MS = 250;

async function checkWithRetry(server, relative) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await checkFile(server, relative);
    } catch (error) {
      if (attempt >= CHECK_ATTEMPTS) throw error;
      await sleep(RETRY_AFTER_CHECK_FAILURE_MS);
    }
  }
}

async function recheck(server, relative) {
  const ticket = (checkTickets.get(relative) ?? 0) + 1;
  checkTickets.set(relative, ticket);
  let errors;
  try {
    errors = await checkWithRetry(server, relative);
  } catch (error) {
    status.noteTrace({ event: 'check-failed', file: relative, message: String(error.message).slice(0, 80) });
    return;
  }
  if (checkTickets.get(relative) === ticket) status.setBuildErrors(relative, errors);
}

export async function diagnose(server, relativePaths) {
  const targets = new Set([...relativePaths, ...status.filesWithBuildErrors()]);
  targets.delete(status.UNKNOWN_BUILD_FILE);
  for (const relative of targets) await recheck(server, relative);
}

export function requestScopedReload(server) {
  server.environments.client.hot.send({ type: 'full-reload', path: APP_RELOAD_PATH });
}

async function waitForHotActivity(since) {
  const deadline = Date.now() + LIMITS.propagationWaitMs;
  while (Date.now() < deadline) {
    if (status.lastHotActivityAt() > since) return true;
    await sleep(25);
  }
  return status.lastHotActivityAt() > since;
}

function describe(outcome) {
  const current = status.snapshot();
  const shown = current.errors.slice(0, LIMITS.maxErrorsInResult);
  status.markReported(shown.map((error) => error.id));
  return {
    ...(outcome.hmr && { hmr: outcome.hmr }),
    status: current.status,
    healthy: current.status === 'healthy',
    ...(outcome.recovered && { recovered: true, recoveredBy: outcome.recoveredBy }),
    ...(outcome.packages && (outcome.packages.installed.length > 0 || outcome.packages.rejected.length > 0 || outcome.packages.resolvedWithoutRestart?.length > 0) && { packages: outcome.packages }),
    errorCount: current.errors.length,
    errors: shown.map(({ kind, file, line, column, message, frame, count }) => ({ kind, file, line, column, message, frame, ...(count > 1 && { count }) })),
    ...(current.status === 'no_page' && { note: 'No app page is connected, so runtime behaviour was not verified. Build checks ran.' }),
    ...(current.status === 'unresponsive' && { note: 'An app page stopped responding; it may be stuck in an infinite loop. Fix the code and it will recover.' }),
  };
}

async function forceReload(server) {
  const startedAt = Date.now();
  const targets = status.expectedPages();
  requestScopedReload(server);
  if (targets.length === 0) return;
  await status.waitForAcknowledgements(startedAt, targets, LIMITS.reloadWaitMs);
  await sleep(LIMITS.reloadGraceMs);
}

async function recoverUnresponsive(finish) {
  const startedAt = Date.now();
  const stuck = status.expectedPages().filter((page) => page.frameName === CONTROL_FRAME_NAME);
  status.requestFrameRebuild();
  if (stuck.length > 0) await status.waitForAcknowledgements(startedAt, stuck, LIMITS.reloadWaitMs);
  await sleep(LIMITS.reloadGraceMs);
  const recovered = status.snapshot().status === 'healthy';
  return finish({ hmr: 'frame-rebuild', recovered, recoveredBy: 'frame-rebuild' });
}

async function repairUnresolvedImports(server, changedPaths) {
  const everRegistered = new Set();
  for (let attempt = 0; attempt < LIMITS.resolveRepairAttempts; attempt += 1) {
    const registered = registerResolvable(server, status.snapshot().errors);
    if (registered.length === 0) break;
    registered.forEach((specifier) => everRegistered.add(specifier));
    await sleep(LIMITS.resolveRepairWaitMs);
    await diagnose(server, changedPaths);
  }
  return [...everRegistered];
}

export async function settleChange(server, { changedPaths, startedAt, wasBroken }) {
  await diagnose(server, changedPaths);
  const installation = await installMissingFromErrors(status.snapshot().errors);
  const registered = await repairUnresolvedImports(server, changedPaths);
  const packages = installation || registered.length > 0 ? { installed: [], rejected: [], ...installation, resolvedWithoutRestart: registered } : null;
  const finish = (outcome) => describe({ ...outcome, packages });
  const targets = status.expectedPages();
  if (targets.length === 0) return finish({ hmr: 'no_page' });
  if (status.snapshot().status === 'unresponsive' && !status.hasBuildErrors()) return recoverUnresponsive(finish);
  if (!await waitForHotActivity(startedAt)) return finish({ hmr: 'none' });
  if (status.hasBuildErrors()) {
    await sleep(LIMITS.settleGraceMs);
    return finish({ hmr: 'blocked_by_build_error' });
  }
  const acknowledgements = await status.waitForAcknowledgements(startedAt, targets, LIMITS.settleWaitMs);
  await sleep(LIMITS.settleGraceMs);
  const outcome = { hmr: acknowledgements.all ? (acknowledgements.reloaded ? 'full-reload' : 'hot-update') : 'timeout' };
  const stuck = !acknowledgements.all || status.hasRuntimeErrorKind('hmr-failed') || status.hasRuntimeErrorKind('blank');
  if (stuck && !status.hasBuildErrors()) {
    await forceReload(server);
    outcome.hmr = 'forced-full-reload';
    outcome.recovered = wasBroken && status.snapshot().status === 'healthy';
    outcome.recoveredBy = 'forced-full-reload';
  } else if (wasBroken && status.snapshot().status === 'healthy') {
    outcome.recovered = true;
    outcome.recoveredBy = outcome.hmr;
  }
  return finish(outcome);
}

export async function settleReload(server) {
  await diagnose(server, []);
  await repairUnresolvedImports(server, []);
  const startedAt = Date.now();
  const targets = status.expectedPages();
  requestScopedReload(server);
  if (targets.length === 0) return describe({ hmr: 'no_page' });
  const acknowledgements = await status.waitForAcknowledgements(startedAt, targets, LIMITS.reloadWaitMs);
  await sleep(LIMITS.reloadGraceMs);
  return describe({ hmr: acknowledgements.all ? 'full-reload' : 'timeout' });
}

export function describeCurrentStatus() {
  return describe({});
}
