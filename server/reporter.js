(() => {
  if (window.__hmrLiveReporter) return;

  const HEARTBEAT_MS = 2000;
  const pageId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const embedded = window.top !== window;
  const reporter = { pageId, failures: 0, sequence: 0 };
  window.__hmrLiveReporter = reporter;

  const describe = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const isVisible = () => document.visibilityState === 'visible';

  const post = (event) => {
    const body = JSON.stringify({ pageId, embedded, frameName: window.name, url: location.pathname, seq: ++reporter.sequence, ...event });
    fetch('/api/app-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
      .then((response) => {
        if (!response.ok) reporter.failures += 1;
      })
      .catch(() => {
        reporter.failures += 1;
      });
  };

  window.addEventListener('error', (event) => {
    if (event.target && event.target !== window) {
      const url = event.target.src || event.target.href || '';
      const critical = event.target.tagName === 'SCRIPT' || event.target.tagName === 'LINK';
      post({
        type: critical ? 'error' : 'warn',
        kind: 'resource',
        message: `failed to load ${String(event.target.tagName).toLowerCase()} ${url}`,
        file: url,
      });
      return;
    }
    const isSyntax = event.error?.name === 'SyntaxError' || /SyntaxError/.test(event.message);
    post({ type: 'error', kind: isSyntax ? 'syntax' : 'runtime', message: event.message, file: event.filename, line: event.lineno, column: event.colno });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    post({ type: 'error', kind: 'rejection', message: `unhandled rejection: ${describe(event.reason)}` });
  });

  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      const text = values.map(describe).join(' ');
      if (!/^\[vite\] Internal Server Error/.test(text)) {
        post({ type: level, kind: /^\[(?:hmr|vite)\] Failed to reload/.test(text) ? 'hmr-failed' : 'console', message: text });
      }
      original(...values);
    };
  }

  import('/@vite/client')
    .then(({ createHotContext }) => {
      const hot = createHotContext('/api/reporter.js');
      hot.on('vite:beforeUpdate', () => post({ type: 'update-start' }));
      hot.on('vite:afterUpdate', () => {
        post({ type: 'update' });
        const recoveringFromBlank = blank.reported;
        blank.reported = false;
        blank.contentSeen = false;
        setTimeout(() => checkContent(recoveringFromBlank), 1500);
      });
      hot.on('vite:beforeFullReload', () => post({ type: 'reload' }));
      hot.on('vite:ws:disconnect', () => post({ type: 'ws', up: false }));
      hot.on('vite:ws:connect', () => post({ type: 'ws', up: true }));
    })
    .catch(() => {
      reporter.failures += 1;
    });

  const FIRST_CONTENT_CHECK_MS = 1500;
  const BLANK_CHECK_MS = 3000;
  const BLANK_HEAL_AFTER_MS = 8000;
  const BLANK_RELOAD_GUARD_KEY = 'hmr-live-last-blank-reload';
  const BLANK_RELOAD_GUARD_MS = 60000;
  const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'HMR-LIVE-OVERLAY']);
  const CONTENT_TAGS = new Set(['IMG', 'CANVAS', 'SVG', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);
  const blank = { reported: false, since: 0, contentSeen: false };

  const hasVisibleContent = () => {
    if (!document.body) return false;
    for (const element of document.body.querySelectorAll('*')) {
      const tag = element.tagName.toUpperCase();
      if (IGNORED_TAGS.has(tag) || element.closest('hmr-live-overlay, [data-hmr-chrome]')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (CONTENT_TAGS.has(tag)) return true;
      if ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')) return true;
    }
    return false;
  };

  const healBlankPage = () => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(BLANK_RELOAD_GUARD_KEY) || 0);
    } catch {
      last = 0;
    }
    if (Date.now() - last < BLANK_RELOAD_GUARD_MS) return;
    try {
      sessionStorage.setItem(BLANK_RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      reporter.failures += 1;
    }
    location.reload();
  };

  const checkContent = (recoveringFromBlank = false) => {
    if (document.readyState !== 'complete' || !isVisible()) return;
    const present = hasVisibleContent();
    if (present) {
      blank.contentSeen = true;
      if (blank.reported) {
        blank.reported = false;
        post({ type: 'content' });
      }
      return;
    }
    if (!blank.reported) {
      blank.reported = true;
      blank.since = Date.now();
      post({ type: 'error', kind: 'blank', message: 'The page rendered nothing visible after loading. The entry module may have failed silently or be waiting on something that never resolves.' });
      if (recoveringFromBlank) healBlankPage();
    } else if (Date.now() - blank.since >= BLANK_HEAL_AFTER_MS) {
      healBlankPage();
    }
  };

  setInterval(() => {
    if (!blank.contentSeen || blank.reported) checkContent();
  }, BLANK_CHECK_MS);

  window.addEventListener('load', () => setTimeout(() => checkContent(false), FIRST_CONTENT_CHECK_MS));

  post({ type: 'load', href: location.href, visible: isVisible() });
  setInterval(() => post({ type: 'heartbeat', visible: isVisible() }), HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => post({ type: 'visibility', visible: isVisible() }));
  window.addEventListener('pagehide', () => {
    const body = JSON.stringify({ pageId, embedded, url: location.pathname, type: 'unload', seq: ++reporter.sequence });
    navigator.sendBeacon('/api/app-log', new Blob([body], { type: 'application/json' }));
  });

  const overlay = { host: null, panel: null, dismissedRevision: -1, latestRevision: -1 };
  const RELOAD_GUARD_KEY = 'hmr-live-last-server-reload';
  const RELOAD_GUARD_MS = 3000;
  let knownServerId = null;

  const reloadForNewServer = () => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    } catch {
      last = 0;
    }
    if (Date.now() - last < RELOAD_GUARD_MS) return;
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      reporter.failures += 1;
    }
    location.reload();
  };

  const buildOverlay = () => {
    const host = document.createElement('hmr-live-overlay');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .backdrop { position: fixed; inset: 0; background: rgba(12, 12, 14, 0.78); overflow: auto; padding: 24px; box-sizing: border-box; font-family: ui-monospace, Menlo, Consolas, monospace; }
        .panel { max-width: 920px; margin: 0 auto; background: #1b1b1f; color: #f2f2f2; border: 1px solid #ff5f56; border-radius: 8px; padding: 16px 20px; }
        header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; color: #ff8a80; font-weight: 700; }
        button { font: inherit; background: transparent; color: #f2f2f2; border: 1px solid #666; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
        article { border-top: 1px solid #333; padding: 12px 0; }
        .where { color: #ffcc66; }
        .message { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
        pre { margin: 6px 0 0; padding: 8px; background: #101014; border-radius: 6px; overflow: auto; color: #cfcfcf; }
      </style>
      <div class="backdrop"><div class="panel"><header><span class="title"></span><button type="button">Dismiss</button></header><div class="list"></div></div></div>`;
    root.querySelector('button').addEventListener('click', () => {
      overlay.dismissedRevision = overlay.latestRevision;
      host.remove();
    });
    overlay.host = host;
    overlay.panel = root;
  };

  const fill = (snapshot) => {
    overlay.panel.querySelector('.title').textContent = `App error (${snapshot.status}, ${snapshot.errors.length} active)`;
    const list = overlay.panel.querySelector('.list');
    list.replaceChildren();
    for (const error of snapshot.errors.slice(0, 5)) {
      const item = document.createElement('article');
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = `[${error.kind}] ${error.file ?? 'unknown file'}${error.line ? `:${error.line}` : ''}${error.column ? `:${error.column}` : ''}`;
      const message = document.createElement('div');
      message.className = 'message';
      message.textContent = error.message;
      item.append(where, message);
      if (error.frame) {
        const frame = document.createElement('pre');
        frame.textContent = error.frame;
        item.append(frame);
      }
      list.append(item);
    }
  };

  const render = (snapshot) => {
    overlay.latestRevision = snapshot.revision;
    const visible = snapshot.errors.length > 0 && snapshot.revision !== overlay.dismissedRevision;
    if (!visible) {
      overlay.host?.remove();
      return;
    }
    if (!overlay.host) buildOverlay();
    fill(snapshot);
    if (!overlay.host.isConnected) document.documentElement.append(overlay.host);
  };

  const events = new EventSource(`/api/events?page=${encodeURIComponent(pageId)}`);
  events.addEventListener('status', (event) => {
    const snapshot = JSON.parse(event.data);
    if (knownServerId !== null && snapshot.serverId !== knownServerId) {
      reloadForNewServer();
      return;
    }
    knownServerId = snapshot.serverId;
    render(snapshot);
  });
  events.addEventListener('error', () => {
    reporter.failures += 1;
  });
})();
