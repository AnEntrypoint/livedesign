import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, LIMITS, LIVE_MODEL, PAGE_EVENT_TYPES, PROJECT_ROOT, RUNTIME_ERROR_KINDS } from './config.js';
import { HttpError } from './errors.js';
import { runTool } from './tools.js';
import { liveConfig, mintStatsSnapshot, mintToken } from './token.js';
import { serveEvents } from './events.js';
import * as appLog from './appLog.js';
import * as status from './status.js';
import { recentToolCalls } from './toolLog.js';

const REPORTER_SOURCE_PATH = path.join(PROJECT_ROOT, 'server', 'reporter.js');

async function readJsonBody(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'content-type must be application/json');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > LIMITS.maxBodyBytes) throw new HttpError(413, 'body_too_large', `body exceeds ${LIMITS.maxBodyBytes} bytes`);
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'body is not valid JSON');
  }
}

const CONTROL_ROUTES = new Set(['POST /token', 'POST /tool', 'POST /pause', 'GET /config', 'GET /debug']);
const CONTROL_HOSTNAME = 'localhost';

function assertAllowedOrigin(request, route) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, 'cross_origin_forbidden', 'malformed origin');
  }
  if (parsed.host !== request.headers.host) {
    throw new HttpError(403, 'cross_origin_forbidden', 'cross-origin requests are not allowed');
  }
  if (CONTROL_ROUTES.has(route) && parsed.hostname !== CONTROL_HOSTNAME) {
    throw new HttpError(403, 'control_origin_required', `this route is only available to the control page at http://${CONTROL_HOSTNAME}:${parsed.port}/live/, not to app pages`);
  }
}

const recentTokenMints = [];

function spendTokenAllowance() {
  const now = Date.now();
  while (recentTokenMints.length > 0 && now - recentTokenMints[0] > 60 * 1000) recentTokenMints.shift();
  if (recentTokenMints.length >= LIMITS.tokenMintsPerMinute) throw new HttpError(429, 'token_rate_limited', 'too many session tokens requested; wait a minute');
  recentTokenMints.push(now);
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

function shortText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function appRelativePath(fileUrl) {
  if (typeof fileUrl !== 'string' || fileUrl === '') return null;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(fileUrl, 'http://app.invalid').pathname);
  } catch {
    return null;
  }
  return pathname.startsWith('/app/') ? pathname.slice('/app/'.length) : pathname.replace(/^\//, '');
}

function recordPageEvent(body) {
  const { pageId, type } = body;
  if (typeof pageId !== 'string' || !/^[\w-]{8,64}$/.test(pageId)) throw new HttpError(400, 'invalid_page_id', 'pageId must be 8-64 word characters');
  if (!PAGE_EVENT_TYPES.has(type)) throw new HttpError(400, 'invalid_type', `type must be one of ${[...PAGE_EVENT_TYPES].join(', ')}`);
  const detail = {
    seq: integerOrNull(body.seq) ?? 0,
    url: shortText(body.url, 200),
    embedded: body.embedded === true,
    frameName: shortText(body.frameName, 40),
    visible: body.visible !== false,
    up: body.up !== false,
  };
  status.pageEvent(pageId, type, detail);
  if (type === 'load') appLog.record('load', shortText(body.href, 300), detail.url);
  if (type === 'warn') appLog.record('warn', shortText(body.message, LIMITS.appLogTextChars), detail.url);
  if (type === 'error') {
    const kind = RUNTIME_ERROR_KINDS.has(body.kind) ? body.kind : 'runtime';
    const message = shortText(body.message, 1000) || 'unknown error';
    appLog.record('error', `${kind}: ${message}`, detail.url);
    status.addRuntimeError(pageId, {
      kind,
      message,
      file: appRelativePath(body.file),
      line: integerOrNull(body.line),
      column: integerOrNull(body.column),
      seq: detail.seq,
    });
  }
  return { ok: true };
}

export function createApiMiddleware(server) {
  const toolContext = { server };

  const routes = {
    'GET /config': () => liveConfig(),
    'GET /status': () => status.snapshot(),
    'POST /token': () => {
      spendTokenAllowance();
      return mintToken();
    },
    'POST /pause': async (request) => {
      const { paused } = await readJsonBody(request);
      if (typeof paused !== 'boolean') throw new HttpError(400, 'invalid_request', 'paused must be a boolean');
      status.setEditsPaused(paused);
      return { ok: true, paused };
    },
    'POST /tool': async (request) => {
      const { name, args, screen } = await readJsonBody(request);
      if (typeof name !== 'string') throw new HttpError(400, 'invalid_request', 'name must be a string');
      status.setScreen(screen);
      return runTool(name, args, toolContext);
    },
    'POST /app-log': async (request) => recordPageEvent(await readJsonBody(request)),
    'GET /debug': () => ({
      model: LIVE_MODEL,
      appDir: APP_DIR,
      token: mintStatsSnapshot(),
      status: status.snapshot(),
      appLogSequence: appLog.currentSequence(),
      hmrClients: server.ws.clients.size,
      trace: status.traceSnapshot(),
      dependencyOptimizer: server.environments.client.depsOptimizer ? { discovered: Object.keys(server.environments.client.depsOptimizer.metadata.discovered).length, optimized: Object.keys(server.environments.client.depsOptimizer.metadata.optimized).length } : null,
      recentToolCalls: recentToolCalls(),
      limits: LIMITS,
    }),
  };

  return async (request, response, next) => {
    const route = `${request.method} ${request.url.split('?')[0]}`;
    if (route === 'GET /reporter.js') {
      response.setHeader('content-type', 'text/javascript');
      response.setHeader('cache-control', 'no-store');
      response.end(fs.readFileSync(REPORTER_SOURCE_PATH));
      return;
    }
    const streaming = route === 'GET /events';
    if (!streaming && !Object.hasOwn(routes, route)) {
      next();
      return;
    }
    try {
      assertAllowedOrigin(request, route);
      if (streaming) {
        serveEvents(request, response);
        return;
      }
      sendJson(response, 200, await routes[route](request));
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal_error';
      sendJson(response, statusCode, { error: code, message: error.message });
    }
  };
}
