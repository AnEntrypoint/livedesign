import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, PROJECT_ROOT } from './config.js';

const ROOT_MODULES = path.join(PROJECT_ROOT, 'node_modules');
const ESCAPED_AT_RULE = /@\\/;
const CODE_LOADING_AT_RULE = /@(?:plugin|config)\b/i;
const IMPORT_TARGET = /@(?:import|reference)\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"')(;]+))/gi;
const SOURCE_TARGET = /(?:@source\s+(?:not\s+)?|\bsource\(\s*)(?:"([^"]*)"|'([^']*)')/gi;
const REMOTE_URL = /^https?:\/\//i;
const NON_RELATIVE_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|[\\/]|~)/i;
const ALLOWED_STYLE_PACKAGES = /^(?:tailwindcss|tw-animate-css|shadcn|@tailwindcss\/[\w.-]+|@fontsource(?:-variable)?\/[\w.-]+|normalize\.css|modern-normalize)(?:\/(?!\.\.?(?:\/|$))[\w.-]+)*$/;
const MAX_STYLESHEETS = 24;
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;

class CssPolicyViolation extends Error {}

const keyOf = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

function isInsideApp(candidate) {
  const relative = path.relative(APP_DIR, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isInsideRootModules(candidate) {
  const relative = path.relative(ROOT_MODULES, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function targetsOf(pattern, source) {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isFile(file, planned) {
  if (planned.has(keyOf(file))) return true;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readStylesheet(file, planned) {
  const supplied = planned.get(keyOf(file));
  if (supplied !== undefined) return supplied;
  if (fs.statSync(file).size > MAX_STYLESHEET_BYTES) throw new CssPolicyViolation(`${path.basename(file)} is too large to verify`);
  return fs.readFileSync(file, 'utf8');
}

function shadowingDirectory(packageName, stylesheetDir) {
  let directory = stylesheetDir;
  for (;;) {
    if (!isInsideApp(directory) && directory !== APP_DIR) return null;
    if (fs.existsSync(path.join(directory, 'node_modules', ...packageName.split('/')))) return directory;
    if (directory === APP_DIR) return null;
    directory = path.dirname(directory);
  }
}

function resolveAppFile(target, resolved, planned, pending) {
  if (!isInsideApp(resolved) || path.extname(resolved).toLowerCase() !== '.css') {
    throw new CssPolicyViolation(`@import "${target}" must be a .css file inside app/`);
  }
  if (!isFile(resolved, planned)) {
    throw new CssPolicyViolation(`@import "${target}" does not exist inside app/; create that file before importing it`);
  }
  pending.push({ file: resolved, trusted: false });
}

function checkImportTarget(target, stylesheetDir, planned, pending) {
  if (REMOTE_URL.test(target)) return;
  if (target.startsWith('@/')) {
    resolveAppFile(target, path.resolve(APP_DIR, target.slice(2)), planned, pending);
    return;
  }
  if (target.startsWith('.')) {
    resolveAppFile(target, path.resolve(stylesheetDir, target), planned, pending);
    return;
  }
  const climbs = target.split('/').some((segment) => segment === '.' || segment === '..');
  if (climbs || NON_RELATIVE_SCHEME.test(target)) {
    throw new CssPolicyViolation(`@import "${target}" is not an allowed stylesheet source; use a .css file inside app/ or a stylesheet from tailwindcss, tw-animate-css, shadcn or @fontsource`);
  }
  const packageName = packageNameOf(target);
  const shadow = shadowingDirectory(packageName, stylesheetDir);
  if (shadow !== null) throw new CssPolicyViolation(`@import "${target}" would load a "${packageName}" copy from ${path.relative(PROJECT_ROOT, shadow)}${path.sep}node_modules inside app/; packages come from the project node_modules only`);
  const relative = path.resolve(stylesheetDir, target);
  if (/\.css$/i.test(target) && isInsideApp(relative) && isFile(relative, planned)) {
    pending.push({ file: relative, trusted: false });
    return;
  }
  if (ALLOWED_STYLE_PACKAGES.test(target)) return;
  const packaged = path.join(ROOT_MODULES, ...target.split('/'));
  if (/\.css$/i.test(target) && isInsideRootModules(packaged) && isFile(packaged, planned)) {
    pending.push({ file: packaged, trusted: true });
    return;
  }
  throw new CssPolicyViolation(`@import "${target}" is not an allowed stylesheet source; use a .css file inside app/ or a stylesheet from tailwindcss, tw-animate-css, shadcn or @fontsource`);
}

function checkSourceTarget(target, stylesheetDir) {
  if (target === 'none' || target === '') return;
  if (NON_RELATIVE_SCHEME.test(target) || !isInsideApp(path.resolve(stylesheetDir, target)) && path.resolve(stylesheetDir, target) !== APP_DIR) {
    throw new CssPolicyViolation(`source "${target}" must stay inside app/`);
  }
}

function checkStylesheet(source, { file, trusted }, planned, pending) {
  if (ESCAPED_AT_RULE.test(source)) throw new CssPolicyViolation('escaped at-rule names are not allowed');
  const forbidden = CODE_LOADING_AT_RULE.exec(source);
  if (forbidden) throw new CssPolicyViolation(`${forbidden[0]} would run code inside the dev server and is not allowed`);
  if (trusted) return;
  const stylesheetDir = path.dirname(file);
  for (const target of targetsOf(IMPORT_TARGET, source)) checkImportTarget(target, stylesheetDir, planned, pending);
  for (const target of targetsOf(SOURCE_TARGET, source)) checkSourceTarget(target, stylesheetDir);
}

export function assertStylesheetAllowed(source, filePath, plannedFiles = []) {
  const planned = new Map(plannedFiles.map(({ absolute, content }) => [keyOf(absolute), content]));
  const pending = [];
  const visited = new Set();
  checkStylesheet(source, { file: filePath, trusted: false }, planned, pending);
  while (pending.length > 0) {
    const next = pending.pop();
    const key = keyOf(next.file);
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > MAX_STYLESHEETS) throw new CssPolicyViolation('too many nested stylesheet imports');
    checkStylesheet(readStylesheet(next.file, planned), next, planned, pending);
  }
}

export function stylesheetViolation(source, filePath, plannedFiles = []) {
  try {
    assertStylesheetAllowed(source, filePath, plannedFiles);
    return null;
  } catch (error) {
    if (error instanceof CssPolicyViolation) return error.message;
    throw error;
  }
}

export function stylesheetPolicyPlugin() {
  return {
    name: 'hmr-live-stylesheet-policy',
    enforce: 'pre',
    transform(code, id) {
      const filePath = path.normalize(id.split('?')[0]);
      if (!filePath.startsWith(APP_DIR + path.sep) || !/\.css(?:$|\?)/i.test(id)) return null;
      try {
        assertStylesheetAllowed(code, filePath);
      } catch (error) {
        if (error instanceof CssPolicyViolation) this.error(`stylesheet policy: ${error.message}`);
        throw error;
      }
      return null;
    },
  };
}
