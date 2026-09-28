import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, TMP_DIR } from './config.js';
import { ToolError } from './errors.js';

const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 25;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function replaceFile(temporary, target) {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      if (!LOCK_CODES.has(error.code)) throw error;
      await sleep(RENAME_BACKOFF_MS * 2 ** attempt);
    }
  }
  try {
    await fs.copyFile(temporary, target);
  } catch (error) {
    if (!LOCK_CODES.has(error.code)) throw error;
    throw new ToolError('file_busy', `${path.basename(target)} is locked by another process; retry in a moment`);
  }
}

export async function writeAtomically(absolute, content) {
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
  if (bytes > LIMITS.maxFileBytes) throw new ToolError('content_too_large', `content exceeds ${LIMITS.maxFileBytes} bytes`);
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(TMP_DIR, `${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content);
    await replaceFile(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return bytes;
}
