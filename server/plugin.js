import fs from 'node:fs/promises';
import path from 'node:path';
import { createApiMiddleware } from './api.js';
import { closeEventStreams } from './events.js';
import { stylesheetPolicyPlugin } from './cssPolicy.js';
import { APP_DIR, APP_RELOAD_PATH, LIMITS, PROJECT_ROOT } from './config.js';
import { stopParseWorker, warmParseWorker } from './safeParse.js';
import { diagnose } from './settle.js';
import { startSnapshotting } from './snapshot.js';
import { relativeOf } from './diagnostics.js';
import * as status from './status.js';

const CHECKED_EVENTS = new Set(['add', 'change', 'unlink']);

function viteErrorFile(error) {
  const candidate = error?.loc?.file ?? error?.id;
  return typeof candidate === 'string' ? relativeOf(candidate.split('?')[0]) : null;
}

function interceptHotSends(server) {
  const hot = server.environments.client.hot;
  const send = hot.send.bind(hot);
  hot.send = (...args) => {
    const payload = args[0];
    if (payload !== null && typeof payload === 'object') {
      if (payload.type === 'full-reload' && (payload.path === undefined || payload.path === '*') && typeof payload.triggeredBy === 'string' && relativeOf(payload.triggeredBy) !== null) {
        payload.path = APP_RELOAD_PATH;
      }
      if (['update', 'full-reload', 'error'].includes(payload.type)) status.noteHotActivity();
      if (payload.type === 'error') {
        const file = viteErrorFile(payload.err);
        const message = String(payload.err?.message ?? 'build error').split('\n')[0];
        status.setBuildErrorsFromHotPayload(file ?? status.UNKNOWN_BUILD_FILE, [{
          kind: /Failed to resolve import/.test(message) ? 'resolve' : 'transform',
          file: file ?? null,
          line: payload.err?.loc?.line ?? null,
          column: payload.err?.loc?.column ?? null,
          message,
          frame: payload.err?.frame ?? null,
        }]);
      }
    }
    return send(...args);
  };
}

async function listAppFiles(directory, found = []) {
  for (const child of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, child.name);
    if (child.isDirectory()) await listAppFiles(absolute, found);
    else if (child.isFile()) found.push(relativeOf(absolute));
  }
  return found;
}

async function scanApp(server) {
  await diagnose(server, await listAppFiles(APP_DIR));
}

function watchApp(server) {
  const pending = new Map();
  server.watcher.on('all', (event, file) => {
    if (!CHECKED_EVENTS.has(event)) return;
    const relative = relativeOf(file);
    if (relative === null) return;
    clearTimeout(pending.get(relative));
    pending.set(relative, setTimeout(async () => {
      pending.delete(relative);
      try {
        await diagnose(server, [relative]);
      } catch (error) {
        server.config.logger.error(`hmr-live diagnostics failed for ${relative}: ${error.message}`);
      }
    }, LIMITS.watchDebounceMs));
  });
}

const SCRIPT_TAG = /<script\b[^>]*>[\s\S]*?<\/script>\s*/g;
const HMR_SCRIPT = /@vite\/client|@react-refresh/;

const LIVE_DIR = path.join(PROJECT_ROOT, 'live');
const URL_DECODE_PASSES = 3;

function isInsideDirectory(directory, file) {
  if (typeof file !== 'string') return false;
  const relative = path.relative(directory, path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizedRequestPath(url) {
  let decoded = url.split('?')[0];
  for (let pass = 0; pass < URL_DECODE_PASSES; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return path.posix.normalize(decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/')).toLowerCase();
}

function redirectControlPageToLocalhost(request, response, next) {
  const host = request.headers.host ?? '';
  const onLoopbackAddress = /^127\.0\.0\.1(?::\d+)?$/.test(host);
  const requested = normalizedRequestPath(request.url);
  if (!onLoopbackAddress || (requested !== '/live' && !requested.startsWith('/live/'))) {
    next();
    return;
  }
  response.statusCode = 302;
  response.setHeader('location', `http://localhost${host.slice('127.0.0.1'.length)}${request.url}`);
  response.end();
}

function controlPageWithoutHmr() {
  return {
    name: 'hmr-live-control-page-without-hmr',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!isInsideDirectory(LIVE_DIR, context.filename)) return html;
        return html.replace(SCRIPT_TAG, (tag) => (HMR_SCRIPT.test(tag) ? '' : tag));
      },
    },
  };
}

export function hmrLivePlugin() {
  return [stylesheetPolicyPlugin(), appErrorPipelinePlugin(), controlPageWithoutHmr()];
}

function appErrorPipelinePlugin() {
  return {
    name: 'hmr-live',
    config() {
      return {
        server: {
          host: '127.0.0.1',
          cors: false,
          hmr: { overlay: false },
          watch: { ignored: ['**/.gm/**', '**/.hmr-live/**', '**/.agentplug*/**', '**/.env'] },
        },
      };
    },
    configureServer(server) {
      const close = server.close.bind(server);
      server.close = async () => {
        closeEventStreams();
        stopParseWorker();
        return close();
      };
      server.middlewares.use(redirectControlPageToLocalhost);
      interceptHotSends(server);
      watchApp(server);
      startSnapshotting(server);
      warmParseWorker().catch(() => {});
      scanApp(server).catch((error) => server.config.logger.error(`hmr-live startup scan failed: ${error.message}`));
      server.middlewares.use('/api', createApiMiddleware(server));
    },
    closeBundle() {
      closeEventStreams();
      stopParseWorker();
    },
    transformIndexHtml(_html, context) {
      if (!isInsideDirectory(APP_DIR, context.filename)) return undefined;
      return [{ tag: 'script', attrs: { src: '/api/reporter.js' }, injectTo: 'head-prepend' }];
    },
  };
}
