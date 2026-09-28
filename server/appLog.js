import { LIMITS } from './config.js';

const LEVELS = new Set(['error', 'warn', 'load']);
const entries = [];
let sequence = 0;

export function isLevel(value) {
  return LEVELS.has(value);
}

export function record(level, text, url) {
  const entry = {
    seq: ++sequence,
    ts: Date.now(),
    level,
    text: String(text).slice(0, LIMITS.appLogTextChars),
    url: String(url ?? '').slice(0, 200),
  };
  entries.push(entry);
  if (entries.length > LIMITS.appLogEntries) entries.shift();
  return entry;
}

export function currentSequence() {
  return sequence;
}

export function read({ limit = 50, sinceSeq = 0, levels = ['error', 'warn'] } = {}) {
  return entries.filter((entry) => entry.seq > sinceSeq && levels.includes(entry.level)).slice(-limit);
}
