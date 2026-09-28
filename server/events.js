import { LIMITS } from './config.js';
import { HttpError } from './errors.js';
import * as status from './status.js';

const streams = new Set();

export function closeEventStreams() {
  for (const response of streams) response.end();
}

export function serveEvents(request, response) {
  if (streams.size >= LIMITS.sseMaxClients) throw new HttpError(503, 'too_many_event_streams', 'event stream capacity reached');
  streams.add(response);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const pageId = new URL(request.url, 'http://local.invalid').searchParams.get('page');
  const identifiedPage = pageId !== null && /^[\w-]{8,64}$/.test(pageId) ? pageId : null;
  const send = (snapshot) => response.write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
  response.write('retry: 2000\n\n');
  send(status.snapshot());
  const stop = status.onChange(send);
  const stopRebuild = status.onFrameRebuild(() => response.write('event: rebuild\ndata: {}\n\n'));
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), LIMITS.sseKeepAliveMs);
  request.on('close', () => {
    streams.delete(response);
    clearInterval(keepAlive);
    stop();
    stopRebuild();
    if (identifiedPage !== null) status.pageEvent(identifiedPage, 'unload');
  });
}
