import fs from 'node:fs';
import { LIMITS, STATE_DIR, TOOL_LOG_FILE } from './config.js';

const ring = [];

function summarizeArgs(args) {
  const summary = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    summary[key] = typeof value === 'string' && value.length > 80 ? `<${value.length} chars>` : value;
  }
  return summary;
}

export function recordToolCall({ name, args, ok, errorCode, durationMs }) {
  const entry = { ts: new Date().toISOString(), name, args: summarizeArgs(args), ok, errorCode: errorCode ?? null, durationMs };
  ring.push(entry);
  if (ring.length > LIMITS.toolLogRing) ring.shift();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(TOOL_LOG_FILE, `${JSON.stringify(entry)}\n`);
}

export function recentToolCalls() {
  return [...ring];
}
