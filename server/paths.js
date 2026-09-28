import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, LIMITS } from './config.js';
import { ToolError } from './errors.js';

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;
const ROOTED = /^([\\/]|[a-zA-Z]:)/;

function isStrictlyInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function realpathOfDeepestAncestor(target) {
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), path.relative(current, target));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      current = parent;
    }
  }
}

function segmentsOf(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > LIMITS.maxPathChars) {
    throw new ToolError('invalid_path', 'path must be a non-empty string of at most 200 characters');
  }
  if (FORBIDDEN_CHARS.test(relativePath)) {
    throw new ToolError('invalid_path', 'path contains a forbidden character');
  }
  if (ROOTED.test(relativePath)) {
    throw new ToolError('invalid_path', 'path must be relative to app/');
  }
  const segments = relativePath.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ToolError('invalid_path', 'path segments must be plain names');
    }
    if (/[. ]$/.test(segment) || segment.includes('~') || RESERVED_NAME.test(segment)) {
      throw new ToolError('invalid_path', `path segment "${segment}" is not allowed on Windows`);
    }
  }
  return segments;
}

export function sandboxed(relativePath) {
  const segments = segmentsOf(relativePath);
  const realRoot = fs.realpathSync(APP_DIR);
  const absolute = path.resolve(realRoot, ...segments);
  if (!isStrictlyInside(realRoot, absolute) || !isStrictlyInside(realRoot, realpathOfDeepestAncestor(absolute))) {
    throw new ToolError('path_outside_app', 'path resolves outside app/');
  }
  return { absolute, relative: segments.join('/') };
}
