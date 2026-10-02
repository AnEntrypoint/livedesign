import { PROTECTED_APP_FILES } from './config.js';
import { ToolError } from './errors.js';
import { languageOf } from './parseLanguage.js';
import { parseSafely } from './safeParse.js';
import { writeAtomically } from './atomicWrite.js';

const canonical = (relative) => relative.normalize('NFKC').toLowerCase();
const PROTECTED = new Set([...PROTECTED_APP_FILES].map(canonical));
const RESERVED_PUBLIC_NAME = /^public\/(?:(?:live|api|app|@vite|@fs|@id|node_modules)(?:\/|$)|(?:index\.html|favicon\.ico)$)/;

export function assertNotProtected(relative) {
  if (RESERVED_PUBLIC_NAME.test(canonical(relative))) {
    throw new ToolError('protected_file', `${relative} would shadow a control-page or dev-server URL when served from the public folder; use another file name`);
  }
  if (PROTECTED.has(canonical(relative))) {
    throw new ToolError('protected_file', `${relative} is the app harness that error detection and recovery depend on. Put UI code in app/page.tsx and components instead; only the user edits this file.`);
  }
}

export async function assertSafeToWrite(relative, content, lane = 'interactive') {
  const language = languageOf(relative);
  if (language === null) return;
  const parsed = await parseSafely(content, language, 'check', lane);
  if (parsed.crashed && parsed.transient) {
    throw new ToolError('parse_unavailable', `the safe parse check is temporarily unavailable (${parsed.reason}); nothing was written to ${relative}, retry in a moment`);
  }
  if (parsed.crashed) {
    throw new ToolError('file_too_complex', `${relative} is too large or too deeply nested to parse safely (${parsed.reason}); split it into smaller files or reduce the nesting`);
  }
}

export async function writeAppFile({ absolute, relative }, content) {
  assertNotProtected(relative);
  await assertSafeToWrite(relative, content);
  return writeAtomically(absolute, content);
}

export async function writeVettedFile({ absolute, relative }, content) {
  assertNotProtected(relative);
  return writeAtomically(absolute, content);
}

const fileLocks = new Map();

export async function withFileLock(relative, work) {
  const key = canonical(relative);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  fileLocks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}
