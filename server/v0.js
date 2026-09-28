import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, PROJECT_ROOT, V0_ORIGIN } from './config.js';
import { ToolError } from './errors.js';
import { fetchText } from './upstream.js';
import { moduleSpecifiersOf } from './moduleSpecifiers.js';

const STATIC_CATEGORIES = [
  ['apps-and-games', 'Apps & Games'],
  ['landing-pages', 'Landing Pages'],
  ['dashboards', 'Dashboards'],
  ['components', 'Components'],
  ['login-and-sign-up', 'Login & Sign Up'],
  ['blog-and-portfolio', 'Blog & Portfolio'],
  ['ecommerce', 'E-commerce'],
  ['ai', 'AI'],
  ['animations', 'Animations'],
  ['design-systems', 'Design Systems'],
  ['layouts', 'Layouts'],
  ['website-templates', 'Website Templates'],
  ['agents', 'Agents'],
];

const CATEGORY_SLUG = /^[a-z0-9-]{1,40}$/;
const TEMPLATE_ID = /^[A-Za-z0-9]{6,24}$/;
const RESERVED_SLUGS = new Set(['categories', 'submissions']);
const FILE_MARKER = /\[V0_FILE\]([A-Za-z0-9_+-]*):file="([^"]*)"([^\n]*)\n/g;
const FLIGHT_CHUNK = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
const SHIMMED_NEXT_MODULES = new Set(['next/link', 'next/image', 'next/navigation', 'next/font/google', 'next/font/local', 'next/head', 'next/dynamic']);

const SKIPPED = [
  [/^package(-lock)?\.json$|^(pnpm|yarn)-lock|^bun\.lock/, 'dependency manifests are managed by this project'],
  [/^(next|postcss|tailwind|vite|eslint)\.config\.[a-z]+$|^tsconfig[^/]*\.json$|^components\.json$|^next-env\.d\.ts$/, 'project configuration is managed by this project'],
  [/^\.|^README/i, 'not source code'],
  [/^(main\.tsx|index\.html)$/i, 'the app harness is managed by this project'],
  [/^middleware\.[jt]sx?$|^app\/api\/|\/route\.[jt]sx?$/, 'server-only Next.js file that does not run under Vite'],
  [/^app\/layout\.tsx$/, 'the root layout is not mounted here, page.tsx is'],
  [/\.(test|spec)\.[jt]sx?$/, 'test file'],
];

export function skipReason(filePath) {
  for (const [pattern, reason] of SKIPPED) {
    if (pattern.test(filePath)) return reason;
  }
  return null;
}

const listCache = new Map();
const detailCache = new Map();
const categoriesCache = new Map();

function cached(store, key, ttlMs, maxEntries, produce) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = produce().catch((error) => {
    store.delete(key);
    throw error;
  });
  store.set(key, { at: Date.now(), promise });
  while (store.size > maxEntries) store.delete(store.keys().next().value);
  return promise;
}

async function fetchPage(pathname) {
  try {
    return await fetchText(`${V0_ORIGIN}${pathname}`, 'text/html');
  } catch (error) {
    if (error instanceof ToolError && error.code === 'upstream_not_found') throw new ToolError('template_not_found', 'v0.app has no such page');
    throw error;
  }
}

function flightOf(html) {
  const chunks = [];
  for (const match of html.matchAll(FLIGHT_CHUNK)) chunks.push(JSON.parse(`"${match[1]}"`));
  return chunks.join('');
}

const RECORD_SCAN_CHARS_PER_OBJECT = 200000;
const RECORD_SCAN_BUDGET_FACTOR = 4;

function objectEnd(text, start, budget = { remaining: RECORD_SCAN_CHARS_PER_OBJECT }) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    budget.remaining -= 1;
    if (budget.remaining < 0) return -1;
    const character = text[index];
    if (inString) {
      if (character === '\\') index += 1;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function parseObject(text, start, budget) {
  const end = objectEnd(text, start, budget);
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end));
  } catch {
    return null;
  }
}

function normalizeRecord(raw) {
  return {
    id: raw.templateCanonId,
    blockId: raw.blockId,
    title: String(raw.title ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    category: raw.category ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    uses: Number.isFinite(raw.uses) ? raw.uses : 0,
    likes: Number.isFinite(raw.likeCount) ? raw.likeCount : 0,
    author: raw.authorUsername ?? null,
    demoUrl: raw.vercelDeploymentUrl ?? null,
    image: raw.imageUrl ?? null,
    createdAt: String(raw.createdAt ?? '').replace(/^\$D/, '') || null,
  };
}

function recordsFromFlight(flight) {
  const found = new Map();
  const budget = { remaining: Math.max(flight.length * RECORD_SCAN_BUDGET_FACTOR, RECORD_SCAN_CHARS_PER_OBJECT) };
  for (const match of flight.matchAll(/\{"blockId":"b_[A-Za-z0-9]+"/g)) {
    if (budget.remaining < 0) break;
    const raw = parseObject(flight, match.index, budget);
    if (raw?.templateCanonId && !found.has(raw.templateCanonId)) found.set(raw.templateCanonId, normalizeRecord(raw));
  }
  return [...found.values()];
}

export function recordsOf(html) {
  return recordsFromFlight(flightOf(html));
}

function sourceTextOf(flight) {
  const firstMarker = flight.indexOf('[V0_FILE]');
  if (firstMarker < 0) return null;
  let header = null;
  for (const match of flight.slice(0, firstMarker).matchAll(/(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/g)) header = match;
  if (!header) return null;
  let start = header.index + header[0].length;
  const innerHeader = /^[0-9a-f]+:o[0-9a-f]+,/.exec(flight.slice(start, start + 24));
  if (innerHeader) start += innerHeader[0].length;
  const byteLength = parseInt(header[2], 16);
  return Buffer.from(flight.slice(start), 'utf8').subarray(0, byteLength).toString('utf8');
}

function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export async function importsOf(files) {
  const packages = new Set();
  const unsupportedNext = new Set();
  for (const file of files) {
    for (const specifier of await moduleSpecifiersOf(file.content, file.path)) {
      if (!specifier || /^[./~]/.test(specifier) || specifier.startsWith('@/')) continue;
      if (specifier === 'next') continue;
      if (specifier.startsWith('next/')) {
        if (!SHIMMED_NEXT_MODULES.has(specifier)) unsupportedNext.add(specifier);
        continue;
      }
      packages.add(packageOf(specifier));
    }
  }
  const missing = [...packages].filter((name) => !fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', name, 'package.json')));
  return { packages: [...packages].sort(), missing: missing.sort(), unsupportedNext: [...unsupportedNext].sort() };
}

function filesOf(sourceText) {
  const markers = [...sourceText.matchAll(FILE_MARKER)];
  return markers
    .map((marker, index) => {
      const end = index + 1 < markers.length ? markers[index + 1].index : sourceText.length;
      return {
        path: marker[2],
        language: marker[1] || null,
        content: sourceText.slice(marker.index + marker[0].length, end).replace(/\n$/, ''),
      };
    })
    .filter((file) => file.path !== '');
}

function detailOf(html, id) {
  const flight = flightOf(html);
  const sourceText = sourceTextOf(flight);
  if (!sourceText) throw new ToolError('template_source_unavailable', 'This template page does not expose its source publicly.');
  const files = filesOf(sourceText);
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.split(' - ')[0]?.trim() ?? id;
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
  const demoUrl = /"vercelDeploymentUrl":"(https:[^"]+)"/.exec(flight)?.[1] ?? null;
  const record = recordsFromFlight(flight).find((candidate) => candidate.id === id) ?? null;
  return { id, title, description, demoUrl, files, record };
}

function requireTemplateId(id) {
  if (typeof id !== 'string' || !TEMPLATE_ID.test(id)) throw new ToolError('invalid_argument', 'id must be a template id from v0_search, letters and digits only');
  return id;
}

export function categories() {
  return cached(categoriesCache, 'all', LIMITS.v0CategoriesTtlMs, 1, async () => {
    const known = new Map(STATIC_CATEGORIES);
    try {
      const html = await fetchPage('/templates/categories');
      const slugs = [...new Set([...html.matchAll(/href="\/templates\/([a-z0-9-]+)"/g)].map((match) => match[1]))].filter((slug) => !RESERVED_SLUGS.has(slug));
      if (slugs.length > 0) return slugs.map((slug) => ({ slug, label: known.get(slug) ?? slug.replace(/-/g, ' ') }));
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
    }
    return STATIC_CATEGORIES.map(([slug, label]) => ({ slug, label }));
  });
}

function categoryTemplates(slug) {
  if (!CATEGORY_SLUG.test(slug)) throw new ToolError('invalid_argument', 'category must be a slug from v0_categories');
  return cached(listCache, slug, LIMITS.v0ListTtlMs, LIMITS.v0ListCacheEntries, async () => recordsOf(await fetchPage(`/templates/${slug}`)));
}

export function loadTemplate(id) {
  requireTemplateId(id);
  return cached(detailCache, id, LIMITS.v0DetailTtlMs, LIMITS.v0DetailCacheEntries, async () => detailOf(await fetchPage(`/templates/${id}`), id));
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

function tokensOf(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function score(record, tokens) {
  const title = record.title.toLowerCase();
  const titleWords = new Set(tokensOf(record.title));
  const description = record.description.toLowerCase();
  const tags = record.tags.map((tag) => tag.toLowerCase());
  let total = 0;
  for (const token of tokens) {
    if (titleWords.has(token)) total += 5;
    else if (title.includes(token)) total += 3;
    if (tags.includes(token)) total += 4;
    else if (tags.some((tag) => tag.includes(token))) total += 2;
    if (record.category?.includes(token)) total += 2;
    if (description.includes(token)) total += 1;
  }
  return total;
}

const SORTERS = {
  popular: (left, right) => right.uses - left.uses,
  likes: (left, right) => right.likes - left.likes,
  recent: (left, right) => String(right.createdAt).localeCompare(String(left.createdAt)),
};

function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function brief(record) {
  return {
    id: record.id,
    title: record.title.slice(0, 90),
    category: record.category,
    tags: record.tags.slice(0, 6),
    uses: record.uses,
    likes: record.likes,
    author: record.author,
    demoUrl: record.demoUrl,
    description: record.description.slice(0, 160),
  };
}

export async function search({ query, category, tag, sort, limit }) {
  const available = await categories();
  if (category !== undefined && !available.some((entry) => entry.slug === category)) {
    throw new ToolError('unknown_category', `category must be one of: ${available.map((entry) => entry.slug).join(', ')}`);
  }
  const slugs = category ? [category] : available.map((entry) => entry.slug);
  const warnings = [];
  const lists = await mapLimit(slugs, LIMITS.v0FetchConcurrency, async (slug) => {
    try {
      return await categoryTemplates(slug);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      warnings.push(`${slug}: ${error.code}`);
      return [];
    }
  });
  const unique = new Map();
  for (const record of lists.flat()) unique.set(record.id, record);
  const tokens = tokensOf(query);
  let matches = [...unique.values()];
  if (tag) matches = matches.filter((record) => record.tags.some((entry) => entry.toLowerCase().includes(String(tag).toLowerCase())));
  const scored = matches.map((record) => ({ record, score: tokens.length > 0 ? score(record, tokens) : 1 })).filter((entry) => entry.score > 0);
  const chosenSort = sort ?? (tokens.length > 0 ? 'relevance' : 'popular');
  let ordered;
  if (chosenSort === 'random') ordered = shuffled(scored.map((entry) => entry.record));
  else if (chosenSort === 'relevance') ordered = scored.sort((left, right) => right.score - left.score || right.record.uses - left.record.uses).map((entry) => entry.record);
  else if (SORTERS[chosenSort]) ordered = scored.map((entry) => entry.record).sort(SORTERS[chosenSort]);
  else throw new ToolError('invalid_argument', 'sort must be relevance, popular, likes, recent or random');
  const size = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), LIMITS.v0SearchMax) : LIMITS.v0SearchDefault;
  return { total: ordered.length, scanned: unique.size, sort: chosenSort, results: ordered.slice(0, size).map(brief), ...(warnings.length > 0 && { warnings }) };
}

export async function describeTemplate(id) {
  const detail = await loadTemplate(id);
  const listed = detail.record;
  const imports = await importsOf(detail.files.filter((file) => !skipReason(file.path)));
  return {
    id,
    title: listed?.title || detail.title,
    description: (listed?.description || detail.description).slice(0, 500),
    category: listed?.category ?? null,
    tags: listed?.tags ?? [],
    author: listed?.author ?? null,
    uses: listed?.uses ?? null,
    likes: listed?.likes ?? null,
    demoUrl: listed?.demoUrl ?? detail.demoUrl,
    files: detail.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') })),
    packages: imports.packages,
    missingPackages: imports.missing,
    unsupportedNextImports: imports.unsupportedNext,
  };
}

export async function readTemplateFile(id, filePath) {
  const detail = await loadTemplate(id);
  const file = detail.files.find((candidate) => candidate.path === filePath);
  if (!file) throw new ToolError('unknown_path', `template has no file "${filePath}"; call v0_template for the file list`);
  const truncated = file.content.length > LIMITS.v0ReadChars;
  return { path: file.path, bytes: Buffer.byteLength(file.content, 'utf8'), truncated, content: truncated ? file.content.slice(0, LIMITS.v0ReadChars) : file.content };
}
