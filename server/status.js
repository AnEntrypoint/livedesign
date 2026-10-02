import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { LIMITS } from './config.js';
import { redactSecrets } from './env.js';

const SERVER_ID = randomUUID();
export const UNKNOWN_BUILD_FILE = '(unknown)';
const DEPARTED_PAGE_MEMORY_MS = 30000;

const bus = new EventEmitter();
bus.setMaxListeners(LIMITS.sseMaxClients + 10);

const buildErrors = new Map();
const runtimeErrors = new Map();
const pages = new Map();
const departedPages = new Map();
const acknowledgements = [];
const state = { editsPaused: false, revision: 0, signature: '', lastHotActivityAt: 0 };

function fingerprintOf(error) {
  return [error.kind, error.file ?? '', error.line ?? '', String(error.message).slice(0, 160)].join('|');
}

function toRecord(error, extra) {
  return {
    id: fingerprintOf(error),
    kind: error.kind,
    file: error.file ?? null,
    line: error.line ?? null,
    column: error.column ?? null,
    message: redactSecrets(String(error.message).slice(0, 1000)),
    frame: error.frame ? redactSecrets(String(error.frame).slice(0, LIMITS.errorFrameChars)) : null,
    since: Date.now(),
    reported: false,
    ...extra,
  };
}

function isForgotten(page, now) {
  const limit = page.visible ? LIMITS.visiblePageForgetMs : LIMITS.hiddenPageForgetMs;
  return now - page.lastSeen > limit;
}

function isSuperseded(page) {
  return [...pages.values()].some((newer) => newer.id !== page.id
    && newer.embedded === page.embedded
    && newer.url === page.url
    && newer.loadedAt > page.loadedAt
    && page.lastSeen < newer.loadedAt);
}

function pruneForgottenPages() {
  const now = Date.now();
  for (const [id, page] of pages) {
    if (isForgotten(page, now) || isSuperseded(page)) removePage(id);
  }
}

function removePage(pageId) {
  pages.delete(pageId);
  for (const [key, error] of runtimeErrors) {
    if (error.pageId === pageId) runtimeErrors.delete(key);
  }
}

function isUnresponsive(page, now) {
  return page.visible && now - page.lastSeen > LIMITS.unresponsiveAfterMs;
}

function activeErrors() {
  const build = [...buildErrors.values()].flat();
  const runtime = [...runtimeErrors.values()];
  const symptomsHidden = build.length > 0 ? runtime.filter((error) => error.kind !== 'hmr-failed') : runtime;
  return [...build, ...symptomsHidden];
}

function statusOf(errors, now) {
  const livePages = [...pages.values()];
  if (livePages.some((page) => isUnresponsive(page, now))) return 'unresponsive';
  if (errors.length > 0) return 'broken';
  if (livePages.length === 0) return 'no_page';
  return 'healthy';
}

function describePage(page, now) {
  return { id: page.id, url: page.url, embedded: page.embedded, frameName: page.frameName, visible: page.visible, responsive: !isUnresponsive(page, now), socketUp: page.socketUp };
}

export function snapshot() {
  pruneForgottenPages();
  const now = Date.now();
  const errors = activeErrors();
  return {
    serverId: SERVER_ID,
    status: statusOf(errors, now),
    revision: state.revision,
    editsPaused: state.editsPaused,
    errors: errors.map(({ pageId, seq, ...visible }) => visible),
    pages: [...pages.values()].map((page) => describePage(page, now)),
  };
}

function publish() {
  const current = snapshot();
  const signature = JSON.stringify([current.status, current.editsPaused, current.errors.map((error) => error.id), current.pages.map((page) => [page.id, page.responsive, page.visible, page.socketUp])]);
  if (signature === state.signature) return;
  state.signature = signature;
  state.revision += 1;
  bus.emit('change', { ...current, revision: state.revision });
}

export function onChange(listener) {
  bus.on('change', listener);
  return () => bus.off('change', listener);
}

export function onPageEvent(listener) {
  bus.on('page-event', listener);
  return () => bus.off('page-event', listener);
}

export function requestFrameRebuild() {
  bus.emit('rebuild');
}

export function onFrameRebuild(listener) {
  bus.on('rebuild', listener);
  return () => bus.off('rebuild', listener);
}

export function noteHotActivity() {
  state.lastHotActivityAt = Date.now();
}

export function lastHotActivityAt() {
  return state.lastHotActivityAt;
}

const trace = [];

function remember(entry) {
  trace.push({ at: new Date().toISOString().slice(11, 23), ...entry });
  if (trace.length > 300) trace.shift();
}

export function traceSnapshot() {
  return [...trace];
}

export function noteTrace(entry) {
  remember(entry);
}

export function setBuildErrors(file, errors) {
  if (errors.length === 0) {
    if (buildErrors.delete(file)) {
      remember({ event: 'build-error-cleared', file, via: new Error().stack.split('\n')[2].trim().replace(/^at /, '').slice(0, 110) });
      publish();
    }
    return;
  }
  if (!buildErrors.has(file)) remember({ event: 'build-error-set', file, kind: errors[0].kind, message: String(errors[0].message).slice(0, 80) });
  const previous = buildErrors.get(file) ?? [];
  buildErrors.set(file, errors.map((error) => {
    const record = toRecord(error, { file });
    const earlier = previous.find((candidate) => candidate.id === record.id);
    return earlier ? { ...record, since: earlier.since, reported: earlier.reported } : record;
  }));
  publish();
}

export function setBuildErrorsFromHotPayload(file, errors) {
  const existing = buildErrors.get(file) ?? [];
  const incomingIsGeneric = errors.every((error) => error.kind === 'transform');
  const existingIsMoreSpecific = existing.some((error) => error.kind !== 'transform');
  if (incomingIsGeneric && existingIsMoreSpecific) return;
  setBuildErrors(file, errors);
}

export function filesWithBuildErrors() {
  return [...buildErrors.keys()];
}

export function hasBuildErrors() {
  return buildErrors.size > 0;
}

export function hasRuntimeErrorKind(kind) {
  return [...runtimeErrors.values()].some((error) => error.kind === kind);
}

function normalizedMessage(message) {
  return String(message).replace(/https?:\/\/[^/\s]+/g, '').replace(/\?t=\d+/g, '');
}

export function addRuntimeError(pageId, error) {
  remember({ event: 'runtime-error', page: pageId.slice(0, 6), kind: error.kind, seq: error.seq, message: String(error.message).slice(0, 60) });
  const record = toRecord({ ...error, message: normalizedMessage(error.message) }, { pageId, seq: error.seq ?? 0 });
  const key = `${pageId}|${record.id}`;
  const existing = runtimeErrors.get(key);
  runtimeErrors.delete(key);
  runtimeErrors.set(key, existing ? { ...existing, seq: record.seq, count: (existing.count ?? 1) + 1 } : { ...record, count: 1 });
  while (runtimeErrors.size > LIMITS.maxRuntimeErrors) runtimeErrors.delete(runtimeErrors.keys().next().value);
  publish();
}

function clearRuntimeErrorsBefore(pageId, seq) {
  for (const [key, error] of runtimeErrors) {
    if (error.pageId === pageId && error.seq < seq) runtimeErrors.delete(key);
  }
}

function clearRuntimeErrorsOfKind(pageId, kind) {
  for (const [key, error] of runtimeErrors) {
    if (error.pageId === pageId && error.kind === kind) runtimeErrors.delete(key);
  }
}

function acknowledge(entry) {
  acknowledgements.push(entry);
  if (acknowledgements.length > 200) acknowledgements.shift();
}

export function pageEvent(pageId, type, detail = {}) {
  const now = Date.now();
  const seq = Number.isInteger(detail.seq) ? detail.seq : 0;
  if (type !== 'heartbeat') remember({ event: `page-${type}`, page: pageId.slice(0, 6), seq });
  if (type === 'unload') {
    removePage(pageId);
    departedPages.set(pageId, now);
    publish();
    return;
  }
  let page = pages.get(pageId);
  if (!page && type !== 'load' && now - (departedPages.get(pageId) ?? -Infinity) < DEPARTED_PAGE_MEMORY_MS) return;
  if (type === 'load') departedPages.delete(pageId);
  for (const [departedId, departedAt] of departedPages) {
    if (now - departedAt >= DEPARTED_PAGE_MEMORY_MS) departedPages.delete(departedId);
  }
  if (!page || type === 'load') {
    page = { id: pageId, url: detail.url ?? '', embedded: Boolean(detail.embedded), frameName: detail.frameName ?? '', visible: true, loadedAt: now, lastSeen: now, socketUp: true, updateStartSeq: null };
    for (const [otherId, other] of pages) {
      if (otherId !== pageId && other.embedded === page.embedded && other.url === page.url && isUnresponsive(other, now)) removePage(otherId);
    }
    pages.set(pageId, page);
  }
  page.lastSeen = now;
  if (detail.url) page.url = detail.url;
  if (type === 'load') acknowledge({ at: now, type: 'load', pageId, url: page.url, embedded: page.embedded });
  if (type === 'update-start') page.updateStartSeq = seq;
  if (type === 'load' || type === 'update') buildErrors.delete(UNKNOWN_BUILD_FILE);
  if (type === 'update') {
    clearRuntimeErrorsBefore(pageId, page.updateStartSeq ?? seq);
    acknowledge({ at: now, type: 'update', pageId, url: page.url, embedded: page.embedded });
  }
  if (type === 'reload') clearRuntimeErrorsBefore(pageId, Number.MAX_SAFE_INTEGER);
  if (type === 'content') clearRuntimeErrorsOfKind(pageId, 'blank');
  if (type === 'heartbeat' || type === 'visibility') page.visible = detail.visible !== false;
  if (type === 'ws') page.socketUp = detail.up !== false;
  publish();
  bus.emit('page-event', { pageId, type, at: now });
}

export function markReported(ids) {
  const wanted = new Set(ids);
  for (const errors of buildErrors.values()) {
    for (const error of errors) if (wanted.has(error.id)) error.reported = true;
  }
  for (const error of runtimeErrors.values()) {
    if (wanted.has(error.id)) error.reported = true;
  }
  publish();
}

export function expectedPages() {
  pruneForgottenPages();
  return [...pages.values()].filter((page) => page.visible && page.socketUp);
}

export function everyExpectedPageBeatSince(sinceMs) {
  return expectedPages().every((page) => page.lastSeen > sinceMs);
}

export function everyExpectedPageAcknowledgedSince(sinceMs) {
  return expectedPages().every((page) => isAcknowledged(page, sinceMs));
}

function connectedPages() {
  pruneForgottenPages();
  return [...pages.values()].filter((page) => page.socketUp);
}

export function hasConnectedPage() {
  return connectedPages().length > 0;
}

export function everyConnectedPageBeatSince(sinceMs) {
  return connectedPages().every((page) => page.lastSeen > sinceMs);
}

export function everyConnectedPageAcknowledgedSince(sinceMs) {
  return connectedPages().every((page) => isAcknowledged(page, sinceMs));
}

export function pageSeenWithin(pageId, windowMs) {
  const page = pages.get(pageId);
  return page !== undefined && Date.now() - page.lastSeen < windowMs;
}

export function forgetDeparture(pageId) {
  departedPages.delete(pageId);
}

function isAcknowledged(target, since) {
  return acknowledgements.some((entry) => entry.at > since
    && ((entry.type === 'update' && entry.pageId === target.id)
      || (entry.type === 'load' && entry.url === target.url && entry.embedded === target.embedded)));
}

export async function waitForAcknowledgements(since, targets, timeoutMs) {
  const pending = () => targets.filter((target) => !isAcknowledged(target, since));
  if (pending().length === 0) return summarizeAcknowledgements(since, targets);
  await new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    const stop = onPageEvent(() => {
      if (pending().length === 0) done();
    });
    function done() {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
  return summarizeAcknowledgements(since, targets);
}

function summarizeAcknowledgements(since, targets) {
  const missing = targets.filter((target) => !isAcknowledged(target, since));
  const reloaded = acknowledgements.some((entry) => entry.at > since && entry.type === 'load');
  return { all: missing.length === 0, missing: missing.length, reloaded };
}

const screen = { known: false, sharing: false };

export function setScreen(report) {
  if (report !== null && typeof report === 'object' && typeof report.sharing === 'boolean') {
    screen.known = true;
    screen.sharing = report.sharing;
  }
}

export function screenSummary() {
  if (!screen.known) return null;
  if (screen.sharing) return { sharing: true, note: 'The screen is shared with you as a live view. Validate visually against what you are watching and never claim a result you have not actually seen.' };
  return { sharing: false, note: 'The user is not sharing their screen, so you cannot see the app. Do not claim any visual result; rely on status and errors and ask the user to click Share this tab.' };
}

export function setEditsPaused(paused) {
  state.editsPaused = paused;
  publish();
}

export function isEditsPaused() {
  return state.editsPaused;
}

export function isBroken() {
  const current = snapshot();
  return current.status === 'broken' || current.status === 'unresponsive';
}

setInterval(publish, LIMITS.heartbeatMs).unref();
