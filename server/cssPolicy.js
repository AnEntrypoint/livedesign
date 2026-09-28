import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './config.js';

const ESCAPED_AT_RULE = /@\\/;
const CODE_LOADING_AT_RULE = /@(?:plugin|config)\b/i;
const IMPORT_TARGET = /@(?:import|reference)\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"')(;]+))/gi;
const SOURCE_TARGET = /(?:@source\s+(?:not\s+)?|\bsource\(\s*)(?:"([^"]*)"|'([^']*)')/gi;
const REMOTE_URL = /^https?:\/\//i;
const NON_RELATIVE_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|[\\/]|~)/i;
const ALLOWED_STYLE_PACKAGES = /^(?:tailwindcss|tw-animate-css|shadcn|@tailwindcss\/[\w.-]+|@fontsource(?:-variable)?\/[\w.-]+|normalize\.css|modern-normalize)(?:\/(?!\.\.?(?:\/|$))[\w.-]+)*$/;
const MAX_STYLESHEETS = 24;

class CssPolicyViolation extends Error {}

function isInsideApp(candidate) {
  const relative = path.relative(APP_DIR, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function targetsOf(pattern, source) {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function checkImportTarget(target, stylesheetDir, pending) {
  if (REMOTE_URL.test(target)) return;
  if (!target.startsWith('.') && ALLOWED_STYLE_PACKAGES.test(target)) return;
  if (NON_RELATIVE_SCHEME.test(target) || !/\.css$/i.test(target)) {
    throw new CssPolicyViolation(`@import "${target}" is not an allowed stylesheet source; use a .css file inside app/ or a stylesheet from tailwindcss, tw-animate-css, shadcn or @fontsource`);
  }
  const resolved = path.resolve(stylesheetDir, target);
  if (!isInsideApp(resolved)) throw new CssPolicyViolation(`@import "${target}" must be a .css file inside app/`);
  pending.push(resolved);
}

function checkSourceTarget(target, stylesheetDir) {
  if (target === 'none' || target === '') return;
  if (NON_RELATIVE_SCHEME.test(target) || !isInsideApp(path.resolve(stylesheetDir, target)) && path.resolve(stylesheetDir, target) !== APP_DIR) {
    throw new CssPolicyViolation(`source "${target}" must stay inside app/`);
  }
}

function checkStylesheet(source, filePath, pending) {
  if (ESCAPED_AT_RULE.test(source)) throw new CssPolicyViolation('escaped at-rule names are not allowed');
  const forbidden = CODE_LOADING_AT_RULE.exec(source);
  if (forbidden) throw new CssPolicyViolation(`${forbidden[0]} would run code inside the dev server and is not allowed`);
  const stylesheetDir = path.dirname(filePath);
  for (const target of targetsOf(IMPORT_TARGET, source)) checkImportTarget(target, stylesheetDir, pending);
  for (const target of targetsOf(SOURCE_TARGET, source)) checkSourceTarget(target, stylesheetDir);
}

export function assertStylesheetAllowed(source, filePath) {
  const pending = [];
  const visited = new Set();
  checkStylesheet(source, filePath, pending);
  while (pending.length > 0) {
    const next = pending.pop();
    if (visited.has(next)) continue;
    visited.add(next);
    if (visited.size > MAX_STYLESHEETS) throw new CssPolicyViolation('too many nested stylesheet imports');
    let nestedSource;
    try {
      nestedSource = fs.readFileSync(next, 'utf8');
    } catch {
      continue;
    }
    checkStylesheet(nestedSource, next, pending);
  }
}

export function stylesheetViolation(source, filePath) {
  try {
    assertStylesheetAllowed(source, filePath);
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
