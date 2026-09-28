import { LIMITS } from './config.js';
import { ToolError } from './errors.js';
import * as status from './status.js';

const WINDOW_MS = 60 * 1000;
const recentMutations = [];

export function assertMutationAllowed() {
  if (status.isEditsPaused()) {
    throw new ToolError('edits_paused', 'The user paused edits. Do not retry; tell the user and wait for them to resume.');
  }
  const now = Date.now();
  while (recentMutations.length > 0 && now - recentMutations[0] > WINDOW_MS) recentMutations.shift();
  if (recentMutations.length >= LIMITS.mutationsPerMinute) {
    const retryAfterSeconds = Math.ceil((recentMutations[0] + WINDOW_MS - now) / 1000);
    throw new ToolError('rate_limited', `Too many edits in the last minute. retry_after=${retryAfterSeconds}s. Batch changes into fewer, larger edits.`);
  }
  recentMutations.push(now);
}

export function beginChange() {
  assertMutationAllowed();
  return { startedAt: Date.now(), wasBroken: status.isBroken() };
}
