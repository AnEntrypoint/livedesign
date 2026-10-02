import { LIMITS } from './config.js';
import * as status from './status.js';

const streams = new Set();
const cleanupByStream = new Map();
const openStreamsByPage = new Map();
const pendingUnloads = new Map();

function isWritable(response) {
  return response.writable && !response.writableEnded && !response.destroyed;
}

function endStream(response) {
  cleanupByStream.get(response)?.();
  if (!response.writableEnded && !response.destroyed) {
    try {
      response.end();
    } catch {
      response.destroy();
    }
  }
}

export function closeEventStreams() {
  for (const response of [...streams]) endStream(response);
}

function trackPageStream(pageId) {
  clearTimeout(pendingUnloads.get(pageId));
  pendingUnloads.delete(pageId);
  status.forgetDeparture(pageId);
  openStreamsByPage.set(pageId, (openStreamsByPage.get(pageId) ?? 0) + 1);
}

function armUnload(pageId) {
  const timer = setTimeout(() => {
    pendingUnloads.delete(pageId);
    if (openStreamsByPage.has(pageId)) return;
    if (status.pageSeenWithin(pageId, LIMITS.streamReconnectGraceMs)) armUnload(pageId);
    else status.pageEvent(pageId, 'unload');
  }, LIMITS.streamReconnectGraceMs);
  timer.unref();
  pendingUnloads.set(pageId, timer);
}

function releasePageStream(pageId) {
  const remaining = (openStreamsByPage.get(pageId) ?? 1) - 1;
  if (remaining > 0) {
    openStreamsByPage.set(pageId, remaining);
    return;
  }
  openStreamsByPage.delete(pageId);
  armUnload(pageId);
}

function evictOldestStream() {
  const oldest = streams.values().next().value;
  if (oldest === undefined) return;
  streams.delete(oldest);
  endStream(oldest);
}

function writeSafely(response, text) {
  if (!isWritable(response)) return;
  try {
    if (response.writableLength > LIMITS.sseMaxBufferedBytes) response.destroy();
    else response.write(text);
  } catch {
    response.destroy();
  }
}

export function serveEvents(request, response) {
  while (streams.size >= LIMITS.sseMaxClients) evictOldestStream();
  streams.add(response);
  const pageId = new URL(request.url, 'http://local.invalid').searchParams.get('page');
  const identifiedPage = pageId !== null && /^[\w-]{8,64}$/.test(pageId) ? pageId : null;
  if (identifiedPage !== null) trackPageStream(identifiedPage);
  const send = (snapshot) => writeSafely(response, `event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
  const stop = status.onChange(send);
  const stopRebuild = status.onFrameRebuild(() => writeSafely(response, 'event: rebuild\ndata: {}\n\n'));
  const keepAlive = setInterval(() => writeSafely(response, ': keep-alive\n\n'), LIMITS.sseKeepAliveMs);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    streams.delete(response);
    cleanupByStream.delete(response);
    clearInterval(keepAlive);
    stop();
    stopRebuild();
    if (identifiedPage !== null) releasePageStream(identifiedPage);
  };
  cleanupByStream.set(response, release);
  request.on('close', release);
  response.on('close', release);
  response.on('error', release);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  writeSafely(response, 'retry: 2000\n\n');
  send(status.snapshot());
}
