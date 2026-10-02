import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { canonicalFileOf, isAppRootOrInside, isUnderApp, isUnderRootModules } from './appPaths.js';
import { APP_DIR, PROJECT_ROOT } from './config.js';

const ROOT_MODULES = path.join(PROJECT_ROOT, 'node_modules');
const ESCAPED_AT_RULE = /@\\/;
const CODE_LOADING_AT_RULE = /@\s*(?:plugin|config)/i;
const COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;
const IMPORT_PARAMS = /^\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"')(;]+))/i;
const SOURCE_FUNCTION = /\bsource\(\s*(?:"([^"]*)"|'([^']*)')/gi;
const SOURCE_PARAMS = /^\s*(?:not\s+)?(?:"([^"]*)"|'([^']*)')/i;
const ALLOWED_AT_RULES = new Set([
  'import', 'reference', 'source', 'theme', 'apply', 'layer', 'custom-variant', 'variant', 'utility', 'tailwind', 'screen',
  'media', 'supports', 'container', 'keyframes', 'font-face', 'property', 'starting-style', 'scope', 'page', 'namespace', 'charset',
  'font-feature-values', 'counter-style', 'view-transition', 'position-try', 'font-palette-values', 'color-profile', 'custom-media',
]);
const REMOTE_URL = /^https?:\/\//i;
const NON_RELATIVE_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|[\\/]|~)/i;
const ALLOWED_STYLE_PACKAGES = /^(?:tailwindcss|tw-animate-css|shadcn|@tailwindcss\/[\w.-]+|@fontsource(?:-variable)?\/[\w.-]+|normalize\.css|modern-normalize)(?:\/(?!\.\.?(?:\/|$))[\w.-]+)*$/;
const STYLESHEET_ID = /\.css(?:$|\?)|[?&]lang\.css|[?&]index=\d+\.css$/i;
const MAX_STYLESHEETS = 24;
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;

class CssPolicyViolation extends Error {}

const keyOf = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

function isInsideApp(candidate) {
  return isUnderApp(canonicalFileOf(candidate) ?? candidate);
}

function isInsideRootModules(candidate) {
  return isUnderRootModules(canonicalFileOf(candidate) ?? candidate);
}

function isAppRoot(candidate) {
  return isAppRootOrInside(canonicalFileOf(candidate) ?? candidate);
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
    if (!isAppRoot(directory)) return null;
    if (fs.existsSync(path.join(directory, 'node_modules', ...packageName.split('/')))) return directory;
    if (!isInsideApp(directory)) return null;
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
  if (NON_RELATIVE_SCHEME.test(target) || !isAppRoot(path.resolve(stylesheetDir, target))) {
    throw new CssPolicyViolation(`source "${target}" must stay inside app/`);
  }
}

function targetsOfSourceFunction(params) {
  return [...params.matchAll(SOURCE_FUNCTION)].map((match) => match[1] ?? match[2]);
}

function checkAtRule(node, stylesheetDir, planned, pending) {
  const name = node.name.toLowerCase().replace(/^-[a-z]+-/, '');
  if (!ALLOWED_AT_RULES.has(name)) throw new CssPolicyViolation(`@${node.name || '(unnamed)'} is not an at-rule this app allows`);
  if (name === 'import' || name === 'reference') {
    const match = IMPORT_PARAMS.exec(node.params);
    if (match === null) throw new CssPolicyViolation(`@${name} has no readable target`);
    checkImportTarget(match[1] ?? match[2] ?? match[3], stylesheetDir, planned, pending);
  }
  if (name === 'source') {
    const match = SOURCE_PARAMS.exec(node.params);
    if (match !== null) checkSourceTarget(match[1] ?? match[2], stylesheetDir);
    else if (!/^\s*(?:not\s+)?inline\(/i.test(node.params)) throw new CssPolicyViolation('@source needs a quoted path or inline(...)');
  }
  for (const target of targetsOfSourceFunction(node.params)) checkSourceTarget(target, stylesheetDir);
}

function parseStylesheet(source) {
  try {
    return postcss.parse(source);
  } catch (error) {
    throw new CssPolicyViolation(`stylesheet cannot be parsed (${String(error.reason ?? error.message).slice(0, 80)})`);
  }
}

function checkStylesheet(source, { file, trusted }, planned, pending) {
  if (ESCAPED_AT_RULE.test(source)) throw new CssPolicyViolation('escaped at-rule names are not allowed');
  for (const visible of [source.replace(COMMENT, ''), source.replace(COMMENT, ' ')]) {
    const forbidden = CODE_LOADING_AT_RULE.exec(visible);
    if (forbidden) throw new CssPolicyViolation(`${forbidden[0]} would run code inside the dev server and is not allowed`);
  }
  if (trusted) return;
  const stylesheetDir = path.dirname(file);
  parseStylesheet(source).walkAtRules((node) => checkAtRule(node, stylesheetDir, planned, pending));
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
      if (!STYLESHEET_ID.test(id)) return null;
      const filePath = canonicalFileOf(id);
      if (filePath === null || isUnderRootModules(filePath)) return null;
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
