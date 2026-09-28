import { GoogleGenAI, Modality } from '@google/genai';
import { EPHEMERAL_API_VERSION, LIMITS, LIVE_MODEL, SYSTEM_INSTRUCTION } from './config.js';
import { readApiKey } from './env.js';
import { HttpError } from './errors.js';
import { toolDeclarations } from './tools.js';

const mintStats = { minted: 0, failed: 0, lastMintedAt: null };

export function liveConfig() {
  return {
    model: LIVE_MODEL,
    systemInstruction: SYSTEM_INSTRUCTION,
    tools: [{ functionDeclarations: toolDeclarations }],
  };
}

export function mintStatsSnapshot() {
  return { ...mintStats, keyPresent: readApiKey() !== null };
}

function redact(message, apiKey) {
  return String(message).split(apiKey).join('[redacted]');
}

export async function mintToken() {
  const apiKey = readApiKey();
  if (!apiKey) {
    throw new HttpError(503, 'api_key_missing', 'Set GEMINI_API_KEY or GOOGLE_API_KEY in the environment or in .env');
  }
  const now = Date.now();
  const client = new GoogleGenAI({
    apiKey,
    ...(EPHEMERAL_API_VERSION && { httpOptions: { apiVersion: EPHEMERAL_API_VERSION } }),
  });
  const { model, systemInstruction, tools } = liveConfig();
  const expireTime = new Date(now + LIMITS.tokenLifetimeMs).toISOString();
  try {
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime: new Date(now + LIMITS.newSessionWindowMs).toISOString(),
        liveConnectConstraints: {
          model,
          config: { responseModalities: [Modality.AUDIO], systemInstruction, tools },
        },
      },
    });
    mintStats.minted += 1;
    mintStats.lastMintedAt = new Date(now).toISOString();
    return { token: token.name, expireTime, model, apiVersion: EPHEMERAL_API_VERSION };
  } catch (error) {
    mintStats.failed += 1;
    throw new HttpError(502, 'upstream_token_error', redact(error.message, apiKey));
  }
}
