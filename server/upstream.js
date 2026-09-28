import { LIMITS } from './config.js';
import { ToolError } from './errors.js';

const ALLOWED_ORIGINS = new Set(['https://v0.app', 'https://ui.shadcn.com', 'https://registry.npmjs.org', 'https://api.npmjs.org']);
const requests = [];

function spendBudget() {
  const now = Date.now();
  while (requests.length > 0 && now - requests[0] > 60 * 1000) requests.shift();
  if (requests.length >= LIMITS.upstreamFetchesPerMinute) {
    throw new ToolError('upstream_rate_limited', 'Too many outbound requests in the last minute; wait a little and retry, cached results are still served.');
  }
  requests.push(now);
}

async function readCapped(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIMITS.upstreamMaxBodyBytes) {
      await reader.cancel();
      throw new ToolError('upstream_response_too_large', `response exceeded ${LIMITS.upstreamMaxBodyBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchText(url, accept) {
  const origin = new URL(url).origin;
  if (!ALLOWED_ORIGINS.has(origin)) throw new ToolError('upstream_not_allowed', `${origin} is not an allowed source`);
  spendBudget();
  let response;
  try {
    response = await fetch(url, {
      headers: { accept, 'user-agent': 'hmr-live-template-lookup/0.1' },
      signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs),
    });
  } catch (error) {
    throw new ToolError('upstream_unreachable', `could not reach ${origin}: ${error.message}`);
  }
  if (new URL(response.url).origin !== origin) throw new ToolError('upstream_unexpected_redirect', `${origin} redirected to another origin`);
  if (response.status === 404) throw new ToolError('upstream_not_found', `${origin} has no such page`);
  if (response.status === 429) throw new ToolError('upstream_rate_limited', `${origin} is rate limiting this server; retry later`);
  if (!response.ok) throw new ToolError('upstream_unavailable', `${origin} answered ${response.status}`);
  return readCapped(response);
}
