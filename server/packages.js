import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { AUTO_INSTALL_PACKAGES, LIMITS, MIN_WEEKLY_DOWNLOADS, PROJECT_ROOT } from './config.js';
import { ToolError } from './errors.js';
import { fetchText } from './upstream.js';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?<!\.tgz|\.tar|\.gz|\.zip)$/;
const RESOLVE_FAILURE = /Failed to resolve import "([^"]+)"/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const POPULAR_PACKAGES = [
  'react', 'react-dom', 'lodash', 'lodash-es', 'axios', 'express', 'moment', 'chalk', 'commander', 'debug', 'dayjs', 'uuid', 'zod', 'yup', 'joi',
  'classnames', 'clsx', 'tailwindcss', 'typescript', 'vite', 'webpack', 'eslint', 'prettier', 'jquery', 'vue', 'next', 'redux', 'react-redux',
  'react-router', 'react-router-dom', 'framer-motion', 'three', 'd3', 'chart.js', 'recharts', 'lucide-react', 'date-fns', 'swr', 'zustand', 'jotai',
  'immer', 'rxjs', 'socket.io', 'socket.io-client', 'mongoose', 'dotenv', 'cors', 'body-parser', 'async', 'underscore', 'request', 'minimist', 'yargs',
  'semver', 'glob', 'rimraf', 'mkdirp', 'fs-extra', 'inquirer', 'ora', 'node-fetch', 'cross-env', 'nodemon', 'jest', 'mocha', 'chai', 'core-js',
  'tslib', 'react-hook-form', 'react-query', 'styled-components', 'sass', 'postcss', 'autoprefixer', 'prop-types', 'formik', 'validator', 'bcrypt',
  'jsonwebtoken', 'passport', 'nodemailer', 'sharp', 'puppeteer', 'playwright', 'cheerio', 'marked', 'prismjs', 'katex', 'mathjs', 'decimal.js',
  'numeral', 'nanoid', 'ms', 'qs', 'cookie', 'camelcase', 'canvas-confetti', 'react-icons', 'react-markdown', 'react-select', 'react-table',
  'sonner', 'vaul', 'cmdk', 'embla-carousel-react', 'input-otp', 'next-themes', 'tailwind-merge', 'class-variance-authority', 'radix-ui',
  'react-day-picker', 'react-resizable-panels', 'react-dropzone', 'react-toastify', 'react-helmet', 'react-use', 'ramda', 'immutable', 'highlight.js',
];
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const installTimes = [];
let installQueue = Promise.resolve();

export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function isInstalled(name) {
  return fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', ...name.split('/'), 'package.json'));
}

export function unresolvedSpecifiers(errors) {
  const specifiers = new Set();
  for (const error of errors) {
    const specifier = RESOLVE_FAILURE.exec(error.message)?.[1];
    if (!specifier || /^[./~]/.test(specifier) || specifier.startsWith('@/') || specifier === 'next' || specifier.startsWith('next/')) continue;
    if (PACKAGE_NAME.test(packageNameOf(specifier))) specifiers.add(specifier);
  }
  return [...specifiers];
}

export function missingPackagesFromErrors(errors) {
  return [...new Set(unresolvedSpecifiers(errors).map(packageNameOf))].filter((name) => !isInstalled(name));
}

function entryOfPackage(name) {
  const directory = path.join(PROJECT_ROOT, 'node_modules', ...name.split('/'));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const pick = (target) => {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) return pick(target[0]);
    if (target && typeof target === 'object') return pick(target.import ?? target.module ?? target.browser ?? target.default ?? Object.values(target)[0]);
    return undefined;
  };
  const relative = manifest.module ?? pick(manifest.exports?.['.'] ?? manifest.exports) ?? manifest.main ?? 'index.js';
  return path.join(directory, relative);
}

function entryOfSpecifier(specifier) {
  const name = packageNameOf(specifier);
  if (specifier === name) return entryOfPackage(name);
  try {
    return createRequire(path.join(PROJECT_ROOT, 'noop.js')).resolve(specifier);
  } catch {
    return undefined;
  }
}

export function registerResolvable(server, errors) {
  const optimizer = server.environments.client.depsOptimizer;
  if (!optimizer) return [];
  const registered = [];
  for (const specifier of unresolvedSpecifiers(errors)) {
    if (!isInstalled(packageNameOf(specifier))) continue;
    const entry = entryOfSpecifier(specifier);
    if (!entry || !fs.existsSync(entry)) continue;
    optimizer.registerMissingImport(specifier, entry.split(path.sep).join('/'));
    registered.push(specifier);
  }
  return registered;
}

function withinOneEdit(left, right) {
  if (left === right) return false;
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const mismatches = [];
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) mismatches.push(index);
    if (mismatches.length === 1) return true;
    const [first, second] = mismatches;
    return mismatches.length === 2 && second === first + 1 && left[first] === right[second] && left[second] === right[first];
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  let skipped = false;
  for (let shortIndex = 0, longIndex = 0; shortIndex < shorter.length; shortIndex += 1, longIndex += 1) {
    if (shorter[shortIndex] === longer[longIndex]) continue;
    if (skipped) return false;
    skipped = true;
    shortIndex -= 1;
  }
  return true;
}

function ownDependencyNames() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  } catch {
    return [];
  }
}

function likelyTyposquatOf(name) {
  const known = new Set([...POPULAR_PACKAGES, ...ownDependencyNames()]);
  if (known.has(name)) return null;
  return [...known].find((popular) => withinOneEdit(name, popular)) ?? null;
}

function semverParts(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const [leftParts, rightParts] = [semverParts(left), semverParts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function newestEligibleVersion(document) {
  const now = Date.now();
  const eligible = Object.keys(document.versions ?? {}).filter((version) => {
    const publishedAt = Date.parse(document.time?.[version]);
    return !version.includes('-') && !document.versions[version].deprecated && Number.isFinite(publishedAt) && now - publishedAt >= LIMITS.minPackageAgeMs;
  });
  return eligible.sort(compareVersions).at(-1) ?? null;
}

export async function vet(name) {
  const typosquatOf = likelyTyposquatOf(name);
  if (typosquatOf) return { name, reject: `looks like a misspelling of the popular package "${typosquatOf}"; if "${name}" is really intended, ask the user to install it themselves` };
  let document;
  try {
    document = JSON.parse(await fetchText(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, 'application/json'));
  } catch (error) {
    if (error instanceof ToolError && error.code === 'upstream_not_found') return { name, reject: 'not published on npm' };
    throw error;
  }
  const latest = document['dist-tags']?.latest;
  const latestDeprecation = latest ? document.versions?.[latest]?.deprecated : undefined;
  if (latestDeprecation) return { name, reject: `its latest release is deprecated: ${String(latestDeprecation).slice(0, 120)}` };
  const version = newestEligibleVersion(document);
  if (!version) return { name, reject: `no stable release older than ${LIMITS.minPackageAgeMs / DAY_MS} days that is not deprecated` };
  const downloads = JSON.parse(await fetchText(`https://api.npmjs.org/downloads/point/last-week/${name}`, 'application/json')).downloads ?? 0;
  if (downloads < MIN_WEEKLY_DOWNLOADS) return { name, reject: `only ${downloads} weekly downloads, below the ${MIN_WEEKLY_DOWNLOADS} safety floor` };
  return { name, version, downloads };
}

function runNpm(specs) {
  return new Promise((resolve, reject) => {
    const args = [NPM_CLI, 'install', ...specs, '--ignore-scripts', '--no-audit', '--no-fund', '--save', '--loglevel=error'];
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-LIMITS.installOutputChars);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new ToolError('install_timeout', `npm install exceeded ${LIMITS.installTimeoutMs / 1000}s`));
    }, LIMITS.installTimeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ToolError('install_failed', error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ToolError('install_failed', `npm exited with ${code}: ${output.trim()}`));
    });
  });
}

function spendInstallBudget(count) {
  const now = Date.now();
  while (installTimes.length > 0 && now - installTimes[0] > HOUR_MS) installTimes.shift();
  if (installTimes.length + count > LIMITS.installMaxPackagesPerHour) {
    throw new ToolError('install_rate_limited', `at most ${LIMITS.installMaxPackagesPerHour} packages can be installed per hour`);
  }
  for (let index = 0; index < count; index += 1) installTimes.push(now);
}

export async function installPackages(requested) {
  const names = [...new Set(requested)];
  const invalid = names.filter((name) => typeof name !== 'string' || !PACKAGE_NAME.test(name));
  if (invalid.length > 0) throw new ToolError('invalid_argument', `not valid npm package names: ${invalid.join(', ')}`);
  const alreadyInstalled = names.filter(isInstalled);
  const wanted = names.filter((name) => !isInstalled(name));
  if (wanted.length > LIMITS.installMaxPackagesPerCall) throw new ToolError('invalid_argument', `install at most ${LIMITS.installMaxPackagesPerCall} packages per call`);
  const vetted = await Promise.all(wanted.map(vet));
  const rejected = vetted.filter((entry) => entry.reject).map((entry) => ({ name: entry.name, reason: entry.reject }));
  const approved = vetted.filter((entry) => !entry.reject);
  if (approved.length === 0) return { installed: [], alreadyInstalled, rejected };
  spendInstallBudget(approved.length);
  const run = installQueue.then(() => runNpm(approved.map((entry) => `${entry.name}@${entry.version}`)));
  installQueue = run.catch(() => undefined);
  await run;
  const installed = approved.map((entry) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'node_modules', ...entry.name.split('/'), 'package.json'), 'utf8'));
    return { name: entry.name, version: manifest.version, weeklyDownloads: entry.downloads };
  });
  return { installed, alreadyInstalled, rejected };
}

export async function installMissingFromErrors(errors) {
  if (!AUTO_INSTALL_PACKAGES) return null;
  const names = missingPackagesFromErrors(errors).slice(0, LIMITS.installMaxPackagesPerCall);
  if (names.length === 0) return null;
  try {
    return await installPackages(names);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { installed: [], rejected: names.map((name) => ({ name, reason: `${error.code}: ${error.message}` })) };
  }
}
