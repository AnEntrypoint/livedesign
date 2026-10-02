import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { APP_DIR, PROJECT_ROOT } from './config.js';

export const CONTROL_HOSTNAME = 'localhost';
export const APP_HOSTNAME = '127.0.0.1';

const URL_DECODE_PASSES = 3;
const HOST_HEADER = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/;
const CONTROL_PAGE_PATH = /^\/live(?:\/|$)/;
const CONTROL_HOST_PATHS = /^(?:\/api(?:\/|$)|\/live(?:\/|$)|\/index\.html$|\/favicon\.ico$|\/@vite\/)/;
const APP_PATH = /^\/app(?:\/|$)/;
const BACKSLASH = String.fromCharCode(92);
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const RESERVED_PUBLIC_PATH = /^\/(?:api|live|app)(?:\/|$)|^\/@|^\/node_modules(?:\/|$)|^\/index\.html$|^\/favicon\.ico$/;
const FS_URL_PREFIX = '/@fs/';
const PUBLIC_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.wasm': 'application/wasm', '.map': 'application/json',
};

export function classifyHost(hostHeader) {
  const match = HOST_HEADER.exec(String(hostHeader ?? '').toLowerCase());
  if (match === null) return { kind: 'unknown', hostname: null, port: null };
  const [, hostname, port] = match;
  if (hostname === CONTROL_HOSTNAME) return { kind: 'control', hostname, port };
  if (hostname === APP_HOSTNAME) return { kind: 'app', hostname, port };
  return { kind: 'unknown', hostname, port };
}

export function normalizedRequestPath(url) {
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

function authority(host, hostname) {
  return host.port === null ? hostname : `${hostname}:${host.port}`;
}

function applySecurityHeaders(response, host) {
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  if (host.kind === 'control') {
    response.setHeader('content-security-policy', "frame-ancestors 'self'");
    response.setHeader('x-frame-options', 'SAMEORIGIN');
  } else if (host.kind === 'app') {
    response.setHeader('content-security-policy', `frame-ancestors http://${authority(host, CONTROL_HOSTNAME)}`);
  }
}

function reject(response, status, code, message) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify({ error: code, message }));
}

function redirect(response, location) {
  response.statusCode = 302;
  response.setHeader('location', location);
  response.setHeader('cache-control', 'no-store');
  response.end();
}

function realOrResolved(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function safeDecode(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function urlSegments(decoded) {
  const segments = decoded.split('/').slice(1);
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  return segments;
}

function hasCanonicalSpelling(pathname) {
  const decoded = safeDecode(pathname);
  if (decoded === null || decoded.includes('\0')) return false;
  if (decoded.startsWith(FS_URL_PREFIX)) {
    const absolute = decoded.slice(FS_URL_PREFIX.length);
    try {
      return fs.realpathSync.native(absolute).replaceAll(BACKSLASH, '/') === absolute;
    } catch {
      return true;
    }
  }
  if (decoded.startsWith('/@') || decoded === '/api' || decoded.startsWith('/api/')) return true;
  const segments = urlSegments(decoded);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  if (segments.length === 0) return true;
  const root = realOrResolved(PROJECT_ROOT);
  let real;
  try {
    real = fs.realpathSync.native(path.join(root, ...segments));
  } catch {
    return true;
  }
  const relative = path.relative(root, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return true;
  return relative.split(path.sep).join('/') === segments.join('/');
}

function servePublicFile(request, response, pathname, dependencyPrefix) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const decoded = safeDecode(pathname);
  if (decoded === null || decoded.includes('\0') || decoded.includes(BACKSLASH)) return false;
  const lowered = decoded.toLowerCase();
  if (RESERVED_PUBLIC_PATH.test(lowered) || lowered.startsWith(dependencyPrefix)) return false;
  const segments = decoded.split('/').slice(1);
  if (segments.length === 0 || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  const realPublic = realOrResolved(PUBLIC_DIR);
  let real;
  let stats;
  try {
    real = fs.realpathSync.native(path.join(realPublic, ...segments));
    stats = fs.statSync(real);
  } catch {
    return false;
  }
  const relative = path.relative(realPublic, real);
  const spelledCanonically = relative.split(path.sep).join('/') === segments.join('/');
  if (!stats.isFile() || relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || !spelledCanonically) return false;
  response.statusCode = 200;
  response.setHeader('content-type', PUBLIC_CONTENT_TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream');
  response.setHeader('content-length', stats.size);
  response.setHeader('cache-control', 'no-cache');
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  pipeline(fs.createReadStream(real), response, () => {});
  return true;
}

function dependencyPrefixOf(config) {
  const relative = path.relative(config.root, config.cacheDir).split(path.sep).join('/');
  return `/${relative}/deps/`.toLowerCase();
}

export function createOriginPartition(config) {
  const dependencyPrefix = dependencyPrefixOf(config);
  return (request, response, next) => partition(request, response, next, dependencyPrefix);
}

function partition(request, response, next, dependencyPrefix) {
  const host = classifyHost(request.headers.host);
  applySecurityHeaders(response, host);
  if (host.kind === 'unknown') {
    reject(response, 421, 'misdirected_request', `use http://${CONTROL_HOSTNAME}/live/ for the control page and http://${APP_HOSTNAME}/app/ for the app`);
    return;
  }
  const requested = normalizedRequestPath(request.url);
  const readsOnly = request.method === 'GET' || request.method === 'HEAD';
  if (host.kind === 'app') {
    const pathname = request.url.split('?')[0];
    if (CONTROL_PAGE_PATH.test(requested)) redirect(response, `http://${authority(host, CONTROL_HOSTNAME)}${request.url}`);
    else if (!hasCanonicalSpelling(pathname)) reject(response, 404, 'non_canonical_path', 'request the exact spelling of the file path');
    else if (!servePublicFile(request, response, pathname, dependencyPrefix)) next();
    return;
  }
  if (requested === '/' || CONTROL_HOST_PATHS.test(requested) || requested.startsWith(dependencyPrefix)) {
    next();
    return;
  }
  if (APP_PATH.test(requested) && readsOnly) {
    redirect(response, `http://${authority(host, APP_HOSTNAME)}${request.url}`);
    return;
  }
  reject(response, 404, 'not_found', `the control origin http://${CONTROL_HOSTNAME} serves only /live/ and /api; the app is at http://${APP_HOSTNAME}/app/`);
}
