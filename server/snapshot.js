import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { APP_DIR, GOOD_DIR, GOOD_STAGING_DIR, LIMITS } from './config.js';
import { ToolError } from './errors.js';
import { absoluteOf, relativeOf } from './diagnostics.js';
import { writeAtomically } from './atomicWrite.js';
import { withFileLock } from './appWrite.js';
import * as status from './status.js';

const GOOD_PREVIOUS_DIR = `${GOOD_DIR}.previous`;
const FAILURE_BACKOFF_MS = 10000;
const SNAPSHOT_IDLE_WAIT_MS = 20000;
const progress = { lastChangeAt: Date.now(), dirty: true, timer: null, taking: false, restoring: false, retryNotBefore: 0 };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function listFiles(root, { limited }) {
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
        if (limited && (found.size >= LIMITS.snapshotMaxFiles || totalBytes > LIMITS.snapshotMaxBytes)) throw new ToolError('snapshot_too_large', 'app/ exceeds the snapshot size limits');
        found.set(path.relative(root, absolute).split(path.sep).join('/'), { absolute, size });
      }
    }
  }
  await walk(root);
  return found;
}

async function readIfPresent(absolute) {
  try {
    return await fs.readFile(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function restoreFile(relative, sourcePath) {
  return withFileLock(relative, async () => {
    const wanted = await fs.readFile(sourcePath);
    const present = await readIfPresent(absoluteOf(relative));
    if (present !== null && present.equals(wanted)) return false;
    await writeAtomically(absoluteOf(relative), wanted);
    return true;
  });
}

async function removeFile(relative) {
  return withFileLock(relative, async () => {
    try {
      await fs.unlink(absoluteOf(relative));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

function isSettledAndHealthy() {
  const settledSince = progress.lastChangeAt + LIMITS.snapshotQuietMs;
  const hotActivityFollowedChange = status.lastHotActivityAt() >= progress.lastChangeAt;
  const applied = !hotActivityFollowedChange || status.everyConnectedPageAcknowledgedSince(progress.lastChangeAt);
  return status.snapshot().status === 'healthy' && status.hasConnectedPage() && applied && status.everyConnectedPageBeatSince(settledSince);
}

async function takeSnapshot() {
  const startedAt = progress.lastChangeAt;
  let files;
  try {
    files = await listFiles(APP_DIR, { limited: true });
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
  if (progress.lastChangeAt !== startedAt || progress.restoring || !isSettledAndHealthy()) {
    await fs.rm(GOOD_STAGING_DIR, { recursive: true, force: true });
    return;
  }
  await fs.rm(GOOD_PREVIOUS_DIR, { recursive: true, force: true });
  if (fsSync.existsSync(GOOD_DIR)) await fs.rename(GOOD_DIR, GOOD_PREVIOUS_DIR);
  await fs.rename(GOOD_STAGING_DIR, GOOD_DIR);
  await fs.rm(GOOD_PREVIOUS_DIR, { recursive: true, force: true });
  progress.dirty = false;
}

async function runSnapshot() {
  progress.taking = true;
  try {
    await takeSnapshot();
  } catch (error) {
    progress.retryNotBefore = Date.now() + FAILURE_BACKOFF_MS;
    status.noteTrace({ event: 'snapshot-failed', message: String(error.message).slice(0, 100) });
  } finally {
    progress.taking = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(progress.timer);
  if (!progress.dirty) return;
  const delay = Math.max(LIMITS.snapshotQuietMs, progress.retryNotBefore - Date.now());
  progress.timer = setTimeout(() => {
    const quiet = Date.now() - progress.lastChangeAt >= LIMITS.snapshotQuietMs;
    if (progress.taking || progress.restoring || !quiet || !isSettledAndHealthy() || Date.now() < progress.retryNotBefore) {
      schedule();
      return;
    }
    void runSnapshot();
  }, delay);
  progress.timer.unref();
}

async function waitForSnapshotIdle() {
  const deadline = Date.now() + SNAPSHOT_IDLE_WAIT_MS;
  while (progress.taking && Date.now() < deadline) await sleep(50);
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
  progress.restoring = true;
  try {
    await waitForSnapshotIdle();
    return await restoreFromSnapshot();
  } finally {
    progress.restoring = false;
    schedule();
  }
}

async function restoreFromSnapshot() {
  if (!fsSync.existsSync(GOOD_DIR)) throw new ToolError('no_snapshot', 'No healthy state has been recorded yet, so there is nothing to restore.');
  const [good, current] = await Promise.all([listFiles(GOOD_DIR, { limited: false }), listFiles(APP_DIR, { limited: false })]);
  const touched = [];
  let restored = 0;
  let deleted = 0;
  for (const [relative, source] of good) {
    if (!await restoreFile(relative, source.absolute)) continue;
    touched.push(relative);
    restored += 1;
  }
  for (const relative of current.keys()) {
    if (good.has(relative)) continue;
    if (!await removeFile(relative)) continue;
    touched.push(relative);
    deleted += 1;
  }
  progress.dirty = false;
  return { restored, deleted, touched };
}
