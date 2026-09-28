import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, API_KEY_NAMES } from './config.js';

function parseDotEnv(text) {
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    entries[name] = value;
  }
  return entries;
}

function readDotEnv() {
  try {
    return parseDotEnv(fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

const REDACTION_CACHE_MS = 5000;
let cachedKey = { readAt: 0, value: null };

export function redactSecrets(text) {
  const now = Date.now();
  if (now - cachedKey.readAt > REDACTION_CACHE_MS) {
    let value = null;
    try {
      value = readApiKey();
    } catch {
      value = null;
    }
    cachedKey = { readAt: now, value };
  }
  return cachedKey.value ? String(text).split(cachedKey.value).join('[redacted]') : String(text);
}

export function readApiKey() {
  const dotEnv = readDotEnv();
  for (const name of API_KEY_NAMES) {
    const value = process.env[name] || dotEnv[name];
    if (value) return value;
  }
  return null;
}
