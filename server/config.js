import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(PROJECT_ROOT, 'app');
export const STATE_DIR = path.join(PROJECT_ROOT, '.hmr-live');
export const TMP_DIR = path.join(STATE_DIR, 'tmp');
export const TOOL_LOG_FILE = path.join(STATE_DIR, 'log.jsonl');
export const GOOD_DIR = path.join(STATE_DIR, 'good');
export const GOOD_STAGING_DIR = path.join(STATE_DIR, 'good.staging');

export const API_KEY_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
export const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
export const EPHEMERAL_API_VERSION = process.env.EPHEMERAL_API_VERSION || null;

export const APP_RELOAD_PATH = '/app/index.html';

export const WRITABLE_EXTENSIONS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.md', '.ts', '.jsx', '.tsx',
]);

export const LIMITS = {
  maxFileBytes: 512 * 1024,
  maxPathChars: 200,
  maxListEntries: 500,
  maxListDepth: 8,
  maxBodyBytes: 1024 * 1024,
  appLogEntries: 200,
  appLogTextChars: 2000,
  reloadWaitMs: 4000,
  toolLogRing: 50,
  tokenLifetimeMs: 30 * 60 * 1000,
  newSessionWindowMs: 2 * 60 * 1000,
  propagationWaitMs: 700,
  settleWaitMs: 5000,
  settleGraceMs: 2000,
  reloadGraceMs: 2800,
  reloadWaitMs: 5000,
  heartbeatMs: 2000,
  unresponsiveAfterMs: 10000,
  hiddenPageForgetMs: 5 * 60 * 1000,
  visiblePageForgetMs: 120 * 1000,
  maxRuntimeErrors: 100,
  maxErrorsInResult: 5,
  errorFrameChars: 600,
  watchDebounceMs: 150,
  mutationsPerMinute: 20,
  sseMaxClients: 20,
  sseKeepAliveMs: 15000,
  snapshotQuietMs: 2000,
  snapshotMaxFiles: 2000,
  snapshotMaxBytes: 50 * 1024 * 1024,
  v0ListTtlMs: 15 * 60 * 1000,
  v0DetailTtlMs: 30 * 60 * 1000,
  v0CategoriesTtlMs: 60 * 60 * 1000,
  upstreamTimeoutMs: 15000,
  upstreamMaxBodyBytes: 12 * 1024 * 1024,
  upstreamFetchesPerMinute: 60,
  shadcnMaxItems: 40,
  resolveRepairAttempts: 3,
  resolveRepairWaitMs: 2500,
  installMaxPackagesPerCall: 5,
  installMaxPackagesPerHour: 15,
  installTimeoutMs: 240000,
  installOutputChars: 600,
  v0FetchConcurrency: 3,
  v0ListCacheEntries: 20,
  v0DetailCacheEntries: 24,
  v0ImportMaxFiles: 60,
  v0ImportMaxBytes: 2 * 1024 * 1024,
  v0ReadChars: 60000,
  v0SearchDefault: 6,
  v0SearchMax: 20,
};

export const AUTO_INSTALL_PACKAGES = process.env.AUTO_INSTALL_PACKAGES !== '0';
export const MIN_WEEKLY_DOWNLOADS = Number(process.env.PACKAGE_MIN_WEEKLY_DOWNLOADS) || 2000;
export const V0_ORIGIN = 'https://v0.app';
export const SHADCN_REGISTRY = 'https://ui.shadcn.com/r/styles/new-york-v4';

export const RUNTIME_ERROR_KINDS = new Set(['runtime', 'syntax', 'rejection', 'console', 'resource', 'hmr-failed', 'blank']);
export const PAGE_EVENT_TYPES = new Set(['load', 'update-start', 'update', 'reload', 'heartbeat', 'visibility', 'unload', 'ws', 'error', 'warn', 'content']);

export const SYSTEM_INSTRUCTION = [
  'You are a live pair-programming agent. The user shares their screen with you as video and talks to you by voice or text.',
  'Change code only when the user explicitly asks you to. Ignore background noise, side conversations and anything that is not a request to you.',
  'The screen shows a web app served from the app/ directory by a Vite dev server with hot module replacement and React Fast Refresh.',
  'app/ is a v0 project root: React 19 with TypeScript, Tailwind CSS and shadcn/ui.',
  'The page is app/app/page.tsx, global styles are app/app/globals.css, components live in app/components and shadcn primitives in app/components/ui, helpers in app/lib/utils.ts with the cn function.',
  'Import project files with the @/ alias, for example @/components/ui/button. next/link, next/image, next/navigation and next/font are supported. Use lucide-react for icons.',
  'File tool paths are relative to app/. Read a file before editing it, and prefer edit_file for small changes.',
  'Every edit tool returns the real outcome: hmr, status and errors with file, line and code frame. Never say a change worked unless status is healthy.',
  'Tool results include a screen field. When screen.sharing is true you receive a fresh video frame of the app right after every edit: look at it before answering, describe only what you actually see, and if the frame contradicts a healthy status, say so and investigate. When screen.sharing is false you cannot see the app, so never claim a visual result.',
  'To build something, search community templates with v0_search, inspect one with v0_template, read files with v0_read_file, and copy it with v0_import. Then adapt it. v0_template lists packages that are not installed, and after an edit or import any missing npm package that passes a registry safety check is installed automatically; the result lists packages installed or rejected with a reason, and if one is rejected pick another approach or tell the user. v0_import already adds missing shadcn components; use add_ui_component when an import of @/components/ui/<name> cannot be resolved.',
  'If status is broken, read the errors, fix the code, and check the next result. After two failed fixes call restore_last_good and tell the user what happened.',
  'Vite applies edits automatically. Call refresh_page only when a full reload is truly needed.',
  'Messages that start with SYSTEM NOTICE come from the app tooling, not from the user. They report app errors. Use read_app_log and fix errors that come from recent edits or the current request, and do not narrate them at length.',
  'If a tool returns edits_paused, stop editing and tell the user. Keep spoken replies short and say what you changed.',
].join(' ');
