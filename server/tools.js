import { Type } from '@google/genai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, LIMITS, WRITABLE_EXTENSIONS } from './config.js';
import { ToolError } from './errors.js';
import { sandboxed } from './paths.js';
import { assertNotProtected, withFileLock, writeAppFile } from './appWrite.js';
import { beginChange, beginRecovery } from './guard.js';
import { describeCurrentStatus, settleChange, settleReload } from './settle.js';
import { restoreLastGood } from './snapshot.js';
import { installPackages } from './packages.js';
import { v0Declarations, v0Handlers } from './v0Tools.js';
import { neutraliseBlock, neutraliseLine } from '../live/untrusted.js';
import * as appLog from './appLog.js';
import * as status from './status.js';
import { recordToolCall } from './toolLog.js';

const pathProperty = { type: Type.STRING, description: 'Path relative to app/, using forward slashes, for example "app/page.tsx" or "components/card.tsx".' };
const OUTCOME_NOTE = ' The result reports the real outcome: hmr, status, and errors with file, line and code frame. Only call the change working when healthy is true; unverified means no visible app page acknowledged it.';

const localDeclarations = [
  {
    name: 'list_files',
    description: 'List every file under app/ with its size in bytes.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'read_file',
    description: 'Read a text file under app/.',
    parameters: { type: Type.OBJECT, properties: { path: pathProperty }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: `Create or fully replace a text file under app/. Parent directories are created. Vite hot-applies the change.${OUTCOME_NOTE}`,
    parameters: {
      type: Type.OBJECT,
      properties: { path: pathProperty, content: { type: Type.STRING, description: 'Complete new file content.' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: `Replace one exact occurrence of old_string with new_string in a file under app/. Fails if old_string is missing or appears more than once.${OUTCOME_NOTE}`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: pathProperty,
        old_string: { type: Type.STRING, description: 'Exact text to replace, unique within the file.' },
        new_string: { type: Type.STRING, description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: `Delete one file under app/.${OUTCOME_NOTE}`,
    parameters: { type: Type.OBJECT, properties: { path: pathProperty }, required: ['path'] },
  },
  {
    name: 'refresh_page',
    description: `Force a full reload of the app page. Use only when hot updates are not enough.${OUTCOME_NOTE}`,
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'read_app_log',
    description: 'Read the current app status, every active error with location and code frame, and recent runtime errors and warnings reported by the app page.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER, description: 'Maximum log entries to return, default 50.' },
        since_seq: { type: Type.INTEGER, description: 'Only log entries with a larger seq, default 0.' },
      },
    },
  },
  {
    name: 'install_packages',
    description: `Install npm packages the app imports. Missing packages are installed automatically after an edit, so use this for explicit installs. Each package is vetted against the public npm registry (must exist and have real adoption) and installed without running install scripts.${OUTCOME_NOTE}`,
    parameters: {
      type: Type.OBJECT,
      properties: { names: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'npm package names such as "canvas-confetti" or "@tanstack/react-query", at most 5.' } },
      required: ['names'],
    },
  },
  {
    name: 'restore_last_good',
    description: `Put every file under app/ back to the last state that ran without errors, deleting files created since. Use after two failed attempts to fix an error.${OUTCOME_NOTE}`,
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

export const toolDeclarations = [...localDeclarations, ...v0Declarations];

function requireString(args, name) {
  if (typeof args[name] !== 'string') throw new ToolError('invalid_argument', `${name} must be a string`);
  return args[name];
}

function requireWritableExtension(absolute) {
  const extension = path.extname(absolute).toLowerCase();
  if (!WRITABLE_EXTENSIONS.has(extension)) {
    throw new ToolError('extension_not_allowed', `extension "${extension}" is not writable; allowed: ${[...WRITABLE_EXTENSIONS].join(' ')}`);
  }
}

async function statFile(absolute) {
  let stats;
  try {
    stats = await fs.stat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ToolError('not_found', 'file does not exist');
    throw error;
  }
  if (!stats.isFile()) throw new ToolError('not_a_file', 'path is not a regular file');
  if (stats.size > LIMITS.maxFileBytes) throw new ToolError('file_too_large', `file exceeds ${LIMITS.maxFileBytes} bytes`);
  return stats;
}

async function listRecursively(directory, depth, found) {
  const children = await fs.readdir(directory, { withFileTypes: true });
  for (const child of children) {
    if (found.length >= LIMITS.maxListEntries) return;
    const absolute = path.join(directory, child.name);
    if (child.isDirectory() && depth < LIMITS.maxListDepth) {
      await listRecursively(absolute, depth + 1, found);
    } else if (child.isFile()) {
      const stats = await fs.stat(absolute);
      found.push({ path: path.relative(APP_DIR, absolute).split(path.sep).join('/'), bytes: stats.size });
    }
  }
}

const handlers = {
  ...v0Handlers,

  async list_files() {
    const files = [];
    await listRecursively(APP_DIR, 0, files);
    return { ok: true, files, truncated: files.length >= LIMITS.maxListEntries };
  },

  async read_file(args) {
    const { absolute, relative } = sandboxed(args.path);
    await statFile(absolute);
    return { ok: true, path: relative, content: await fs.readFile(absolute, 'utf8') };
  },

  async write_file(args, context) {
    const { absolute, relative } = sandboxed(args.path);
    assertNotProtected(relative);
    requireWritableExtension(absolute);
    const content = requireString(args, 'content');
    const { change, bytes } = await withFileLock(relative, async () => {
      const started = beginChange();
      return { change: started, bytes: await writeAppFile({ absolute, relative }, content) };
    });
    return { ok: true, path: relative, bytes, ...await settleChange(context.server, { changedPaths: [relative], ...change }) };
  },

  async edit_file(args, context) {
    const { absolute, relative } = sandboxed(args.path);
    assertNotProtected(relative);
    requireWritableExtension(absolute);
    const oldString = requireString(args, 'old_string');
    const newString = requireString(args, 'new_string');
    if (oldString.length === 0) throw new ToolError('invalid_argument', 'old_string must not be empty');
    const { change, bytes } = await withFileLock(relative, async () => {
      await statFile(absolute);
      const original = await fs.readFile(absolute, 'utf8');
      const occurrences = original.split(oldString).length - 1;
      if (occurrences === 0) throw new ToolError('old_string_not_found', 'old_string does not occur in the file');
      if (occurrences > 1) throw new ToolError('old_string_not_unique', `old_string occurs ${occurrences} times; include more context`);
      const started = beginChange();
      return { change: started, bytes: await writeAppFile({ absolute, relative }, original.replace(oldString, () => newString)) };
    });
    return { ok: true, path: relative, bytes, ...await settleChange(context.server, { changedPaths: [relative], ...change }) };
  },

  async delete_file(args, context) {
    const { absolute, relative } = sandboxed(args.path);
    assertNotProtected(relative);
    const change = await withFileLock(relative, async () => {
      await statFile(absolute);
      const started = beginChange();
      await fs.unlink(absolute);
      return started;
    });
    return { ok: true, path: relative, ...await settleChange(context.server, { changedPaths: [relative], ...change }) };
  },

  async refresh_page(_args, context) {
    return { ok: true, ...await settleReload(context.server) };
  },

  async read_app_log(args) {
    const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), LIMITS.appLogEntries) : 50;
    const sinceSeq = Number.isInteger(args.since_seq) ? args.since_seq : 0;
    const entries = appLog.read({ limit, sinceSeq }).map((entry) => ({
      ...entry,
      text: neutraliseBlock(entry.text, LIMITS.appLogTextChars),
      url: neutraliseLine(entry.url, 200),
    }));
    return { ok: true, ...describeCurrentStatus(), latestSeq: appLog.currentSequence(), ...(entries.length > 0 && { untrustedEntryText: true }), entries };
  },

  async install_packages(args, context) {
    if (!Array.isArray(args.names) || args.names.length === 0) throw new ToolError('invalid_argument', 'names must be a non-empty array of npm package names');
    beginChange();
    const packages = await installPackages(args.names);
    return { ok: true, packages, ...await settleReload(context.server) };
  },

  async restore_last_good(_args, context) {
    const change = beginRecovery();
    const { restored, deleted, touched } = await restoreLastGood();
    return { ok: true, restored, deleted, ...await settleChange(context.server, { changedPaths: touched, ...change }) };
  },
};

export async function runTool(name, args, context) {
  const started = Date.now();
  const safeArgs = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  let result;
  if (!Object.hasOwn(handlers, name)) {
    result = { error: 'unknown_tool', message: `no tool named "${name}"` };
  } else {
    try {
      result = await handlers[name](safeArgs, context);
    } catch (error) {
      result = error instanceof ToolError
        ? { error: error.code, message: error.message }
        : { error: 'tool_failed', message: error.message };
    }
  }
  recordToolCall({ name, args: safeArgs, ok: !result.error, errorCode: result.error, durationMs: Date.now() - started });
  const screen = status.screenSummary();
  return screen ? { ...result, screen } : result;
}
