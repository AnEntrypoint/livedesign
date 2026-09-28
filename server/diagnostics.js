import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAst } from 'vite';
import { APP_DIR } from './config.js';

const PARSE_LANGUAGE = { '.js': 'js', '.mjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx' };
const ANSI = /\u001b\[[0-9;]*m/g;

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

function isCheckable(extension) {
  return extension in PARSE_LANGUAGE || ['.css', '.json', '.html'].includes(extension);
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
  if (!isCheckable(extension)) return [];
  const absolute = absoluteOf(relative);
  let source;
  try {
    source = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (extension in PARSE_LANGUAGE) {
    try {
      parseAst(source, { lang: PARSE_LANGUAGE[extension] });
    } catch (error) {
      return [parseFailure(error, source, relative)];
    }
  }
  if (extension === '.json') {
    try {
      JSON.parse(source);
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
    return [viteFailure(error, relative)];
  }
  return [];
}
