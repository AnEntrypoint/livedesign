import { LIMITS } from './config.js';
import * as status from './status.js';

const streams = new Set();
const openStreamsByPage = new Map();
const pendingUnloads = new Map();

export function closeEventStreams() {
  for (const response of streams) response.end();
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
  streams.delete(oldest);
  oldest.end();
}

function writeUnlessBacklogged(response, text) {
  if (response.writableLength > LIMITS.sseMaxBufferedBytes) {
    response.destroy();
    return;
  }
  response.write(text);
}

export function serveEvents(request, response) {
  while (streams.size >= LIMITS.sseMaxClients) evictOldestStream();
  streams.add(response);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const pageId = new URL(request.url, 'http://local.invalid').searchParams.get('page');
  const identifiedPage = pageId !== null && /^[\w-]{8,64}$/.test(pageId) ? pageId : null;
  if (identifiedPage !== null) trackPageStream(identifiedPage);
  const send = (snapshot) => writeUnlessBacklogged(response, `event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
  response.write('retry: 2000\n\n');
  send(status.snapshot());
  const stop = status.onChange(send);
  const stopRebuild = status.onFrameRebuild(() => writeUnlessBacklogged(response, 'event: rebuild\ndata: {}\n\n'));
  const keepAlive = setInterval(() => writeUnlessBacklogged(response, ': keep-alive\n\n'), LIMITS.sseKeepAliveMs);
  request.on('close', () => {
    streams.delete(response);
    clearInterval(keepAlive);
    stop();
    stopRebuild();
    if (identifiedPage !== null) releasePageStream(identifiedPage);
  });
}
