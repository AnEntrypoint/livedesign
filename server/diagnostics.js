import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR } from './config.js';
import { languageOf } from './parseLanguage.js';
import { parseSafely } from './safeParse.js';

const UNPARSEABLE_MESSAGE = 'file is too large or too deeply nested to parse safely; split it into smaller files or simplify the nesting';
const ANSI = /\u001b\[[0-9;]*m/g;
const STALE_SERVER_FAILURE = /being restarted or closed|Request is outdated/i;

function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

function positionOf(source, offset) {
  const before = source.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function parseFailure(error, source, file) {
  const lines = stripAnsi(error.message).split('\n');
  const summary = lines.find((line, index) => index > 0 && line.trim() !== '' && !/^\d+: /.test(line)) ?? lines[0];
  const numbered = lines.findIndex((line) => /^\d+: /.test(line));
  let line = null;
  let column = null;
  if (Number.isInteger(error.pos)) {
    ({ line, column } = positionOf(source, error.pos));
  } else if (numbered >= 0) {
    const prefix = /^(\d+): /.exec(lines[numbered]);
    line = Number(prefix[1]);
    const caret = lines[numbered + 1]?.indexOf('^');
    column = caret >= 0 ? caret - prefix[0].length + 1 : null;
  }
  const frame = numbered >= 0 ? lines.slice(numbered, numbered + 2).join('\n') : null;
  return { kind: 'syntax', file, line, column, message: summary.trim(), frame };
}

function viteFailure(error, file) {
  const plugin = error.plugin ?? '';
  let kind = 'transform';
  if (plugin.includes('import-analysis') || /Failed to resolve import/.test(error.message)) kind = 'resolve';
  else if (plugin.includes('css') || /\.css$/.test(file)) kind = 'css';
  const location = error.loc ?? {};
  return {
    kind,
    file,
    line: location.line ?? null,
    column: location.column ?? null,
    message: stripAnsi(error.message).split('\n')[0],
    frame: error.frame ? stripAnsi(error.frame) : null,
  };
}

function isCheckable(relative, extension) {
  return languageOf(relative) !== null || ['.css', '.json', '.html'].includes(extension);
}

export function absoluteOf(relative) {
  return path.join(APP_DIR, ...relative.split('/'));
}

export function relativeOf(absolute) {
  const relative = path.relative(APP_DIR, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export async function checkFile(server, relative) {
  const extension = path.extname(relative).toLowerCase();
  if (!isCheckable(relative, extension)) return [];
  const absolute = absoluteOf(relative);
  let source;
  try {
    source = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const language = languageOf(relative);
  if (language) {
    const parsed = await parseSafely(source, language);
    if (parsed.crashed) return [{ kind: 'syntax', file: relative, line: null, column: null, message: UNPARSEABLE_MESSAGE, frame: null }];
    if (!parsed.ok) return [parseFailure(parsed, source, relative)];
  }
  if (extension === '.json') {
    try {
      JSON.parse(source.replace(/^﻿/, ''));
    } catch (error) {
      return [{ kind: 'json', file: relative, line: null, column: null, message: error.message, frame: null }];
    }
    return [];
  }
  const url = `/app/${relative}`;
  try {
    if (extension === '.html') {
      await server.transformIndexHtml(url, source);
    } else {
      server.environments.client.moduleGraph.onFileChange(absolute);
      await server.transformRequest(url);
    }
  } catch (error) {
    if (STALE_SERVER_FAILURE.test(String(error.message))) throw error;
    return [viteFailure(error, relative)];
  }
  return [];
}
