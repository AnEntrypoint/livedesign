import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, PROJECT_ROOT } from './config.js';

const LEADING_DRIVE_SLASH = /^[\\/]+(?=[A-Za-z]:)/;
const CANONICAL_CACHE_LIMIT = 4000;
const canonicalCache = new Map();

function realOrResolved(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

const comparable = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
const realAppDir = realOrResolved(APP_DIR);
const realRootModules = realOrResolved(path.join(PROJECT_ROOT, 'node_modules'));

function isStrictlyInside(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function canonicalFileOf(id) {
  const withoutQuery = String(id).split('?')[0].replace(/^\0/, '').replace(LEADING_DRIVE_SLASH, '');
  const normalized = path.normalize(withoutQuery);
  if (!path.isAbsolute(normalized)) return null;
  const cached = canonicalCache.get(normalized);
  if (cached !== undefined) return cached;
  let existing = normalized;
  let tail = '';
  for (;;) {
    try {
      const real = path.join(fs.realpathSync.native(existing), tail);
      if (tail === '') {
        if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) canonicalCache.clear();
        canonicalCache.set(normalized, real);
      }
      return real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return normalized;
      tail = path.join(path.basename(existing), tail);
      existing = parent;
    }
  }
}

export function isUnderApp(canonicalFile) {
  return isStrictlyInside(realAppDir, canonicalFile);
}

export function isUnderRootModules(canonicalFile) {
  return isStrictlyInside(realRootModules, canonicalFile);
}

export function isAppRootOrInside(canonicalFile) {
  return comparable(canonicalFile) === comparable(realAppDir) || isUnderApp(canonicalFile);
}
