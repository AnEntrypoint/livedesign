import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, LIMITS } from './config.js';
import { ToolError } from './errors.js';

const RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9]|lpt[0-9])[ .]*(\..*)?$/i;
const FORBIDDEN_CHARS = /[<>:"|?*\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u;
const DEPENDENCY_DIRECTORY = 'node_modules';
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

function segmentsOf(givenPath) {
  if (typeof givenPath !== 'string' || givenPath.length === 0 || givenPath.length > LIMITS.maxPathChars) {
    throw new ToolError('invalid_path', 'path must be a non-empty string of at most 200 characters');
  }
  const relativePath = givenPath.normalize('NFKC');
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
    if (segment.toLowerCase() === DEPENDENCY_DIRECTORY) {
      throw new ToolError('invalid_path', 'node_modules cannot be written; packages are installed with install_packages');
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
