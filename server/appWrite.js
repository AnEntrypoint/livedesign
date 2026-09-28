import { PROTECTED_APP_FILES } from './config.js';
import { ToolError } from './errors.js';
import { languageOf } from './parseLanguage.js';
import { parseSafely } from './safeParse.js';
import { writeAtomically } from './atomicWrite.js';

const canonical = (relative) => relative.normalize('NFKC').toLowerCase();
const PROTECTED = new Set([...PROTECTED_APP_FILES].map(canonical));

export function assertNotProtected(relative) {
  if (PROTECTED.has(canonical(relative))) {
    throw new ToolError('protected_file', `${relative} is the app harness that error detection and recovery depend on. Put UI code in app/page.tsx and components instead; only the user edits this file.`);
  }
}

export async function assertSafeToWrite(relative, content, lane = 'interactive') {
  const language = languageOf(relative);
  if (language === null) return;
  const parsed = await parseSafely(content, language, 'check', lane);
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
