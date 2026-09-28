import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { APP_DIR, GOOD_DIR, GOOD_STAGING_DIR, LIMITS } from './config.js';
import { ToolError } from './errors.js';
import { absoluteOf, relativeOf } from './diagnostics.js';
import { writeAtomically } from './atomicWrite.js';
import * as status from './status.js';

const GOOD_PREVIOUS_DIR = `${GOOD_DIR}.previous`;
const progress = { lastChangeAt: Date.now(), dirty: true, timer: null, taking: false };

async function listFiles(root) {
  const found = new Map();
  let totalBytes = 0;
  async function walk(directory) {
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(absolute);
      } else if (child.isFile()) {
        const { size } = await fs.stat(absolute);
        totalBytes += size;
        if (found.size >= LIMITS.snapshotMaxFiles || totalBytes > LIMITS.snapshotMaxBytes) throw new ToolError('snapshot_too_large', 'app/ exceeds the snapshot size limits');
        found.set(path.relative(root, absolute).split(path.sep).join('/'), { absolute, size });
      }
    }
  }
  await walk(root);
  return found;
}

async function sameContent(leftPath, rightPath) {
  const [left, right] = await Promise.all([fs.readFile(leftPath), fs.readFile(rightPath)]);
  return left.equals(right);
}

async function takeSnapshot() {
  const startedAt = progress.lastChangeAt;
  let files;
  try {
    files = await listFiles(APP_DIR);
  } catch (error) {
    if (error instanceof ToolError) return;
    throw error;
  }
  if (files.size === 0) return;
  await fs.rm(GOOD_STAGING_DIR, { recursive: true, force: true });
  for (const [relative, { absolute }] of files) {
    const target = path.join(GOOD_STAGING_DIR, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(absolute, target);
  }
  if (progress.lastChangeAt !== startedAt || status.snapshot().status !== 'healthy') {
    await fs.rm(GOOD_STAGING_DIR, { recursive: true, force: true });
    return;
  }
  await fs.rm(GOOD_PREVIOUS_DIR, { recursive: true, force: true });
  if (fsSync.existsSync(GOOD_DIR)) await fs.rename(GOOD_DIR, GOOD_PREVIOUS_DIR);
  await fs.rename(GOOD_STAGING_DIR, GOOD_DIR);
  await fs.rm(GOOD_PREVIOUS_DIR, { recursive: true, force: true });
  progress.dirty = false;
}

function schedule() {
  clearTimeout(progress.timer);
  if (!progress.dirty) return;
  progress.timer = setTimeout(async () => {
    const quiet = Date.now() - progress.lastChangeAt >= LIMITS.snapshotQuietMs;
    if (progress.taking || !quiet || status.snapshot().status !== 'healthy') {
      if (progress.dirty) schedule();
      return;
    }
    progress.taking = true;
    try {
      await takeSnapshot();
    } finally {
      progress.taking = false;
    }
  }, LIMITS.snapshotQuietMs);
  progress.timer.unref();
}

export function startSnapshotting(server) {
  if (!fsSync.existsSync(GOOD_DIR) && fsSync.existsSync(GOOD_PREVIOUS_DIR)) fsSync.renameSync(GOOD_PREVIOUS_DIR, GOOD_DIR);
  progress.dirty = !fsSync.existsSync(GOOD_DIR);
  server.watcher.on('all', (_event, file) => {
    if (relativeOf(file) === null) return;
    progress.lastChangeAt = Date.now();
    progress.dirty = true;
    schedule();
  });
  status.onChange(schedule);
  schedule();
}

export async function restoreLastGood() {
  if (!fsSync.existsSync(GOOD_DIR)) throw new ToolError('no_snapshot', 'No healthy state has been recorded yet, so there is nothing to restore.');
  const [good, current] = await Promise.all([listFiles(GOOD_DIR), listFiles(APP_DIR)]);
  const touched = [];
  let restored = 0;
  let deleted = 0;
  for (const [relative, source] of good) {
    const existing = current.get(relative);
    if (existing && await sameContent(existing.absolute, source.absolute)) continue;
    await writeAtomically(absoluteOf(relative), await fs.readFile(source.absolute));
    touched.push(relative);
    restored += 1;
  }
  for (const [relative, existing] of current) {
    if (good.has(relative)) continue;
    await fs.unlink(existing.absolute);
    touched.push(relative);
    deleted += 1;
  }
  progress.dirty = false;
  return { restored, deleted, touched };
}
