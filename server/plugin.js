import fs from 'node:fs/promises';
import path from 'node:path';
import { createApiMiddleware } from './api.js';
import { closeEventStreams } from './events.js';
import { APP_DIR, APP_RELOAD_PATH, LIMITS } from './config.js';
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
        status.setBuildErrors(file ?? '(unknown)', [{
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

function controlPageWithoutHmr() {
  return {
    name: 'hmr-live-control-page-without-hmr',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!context.path.startsWith('/live/')) return html;
        return html.replace(SCRIPT_TAG, (tag) => (HMR_SCRIPT.test(tag) ? '' : tag));
      },
    },
  };
}

export function hmrLivePlugin() {
  return [appErrorPipelinePlugin(), controlPageWithoutHmr()];
}

function appErrorPipelinePlugin() {
  return {
    name: 'hmr-live',
    config() {
      return {
        server: {
          host: '127.0.0.1',
          hmr: { overlay: false },
          watch: { ignored: ['**/.gm/**', '**/.hmr-live/**', '**/.agentplug*/**', '**/.env'] },
        },
      };
    },
    configureServer(server) {
      const close = server.close.bind(server);
      server.close = async () => {
        closeEventStreams();
        return close();
      };
      interceptHotSends(server);
      watchApp(server);
      startSnapshotting(server);
      scanApp(server).catch((error) => server.config.logger.error(`hmr-live startup scan failed: ${error.message}`));
      server.middlewares.use('/api', createApiMiddleware(server));
    },
    transformIndexHtml(_html, context) {
      if (!context.path.startsWith('/app/')) return undefined;
      return [{ tag: 'script', attrs: { src: '/api/reporter.js' }, injectTo: 'head-prepend' }];
    },
  };
}
