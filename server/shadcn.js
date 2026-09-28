import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, LIMITS, PROJECT_ROOT, SHADCN_REGISTRY } from './config.js';
import { ToolError } from './errors.js';
import { fetchText } from './upstream.js';

const ITEM_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const LOCAL_IMPORT = /["']@\/(components\/ui|hooks)\/([A-Za-z0-9_-]+)["']/g;
const THEME_PROVIDER_IMPORT = /["']@\/components\/theme-provider["']/;
const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const REGISTRY_TTL_MS = 60 * 60 * 1000;
const registryCache = new Map();

const THEME_PROVIDER_SOURCE = `"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

export function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
`;

function existsLocally(relativeWithoutExtension) {
  return SOURCE_EXTENSIONS.some((extension) => fs.existsSync(path.join(APP_DIR, ...`${relativeWithoutExtension}${extension}`.split('/'))));
}

function withoutExtension(relative) {
  return relative.replace(/\.(tsx|ts|jsx|js)$/, '');
}

async function registryItem(name) {
  if (!ITEM_NAME.test(name)) throw new ToolError('invalid_argument', `"${name}" is not a valid component name`);
  const hit = registryCache.get(name);
  if (hit && Date.now() - hit.at < REGISTRY_TTL_MS) return hit.promise;
  const promise = fetchText(`${SHADCN_REGISTRY}/${name}.json`, 'application/json').then((text) => {
    const item = JSON.parse(text);
    if (!Array.isArray(item.files)) throw new ToolError('registry_item_invalid', `registry item "${name}" has no files`);
    return item;
  }).catch((error) => {
    registryCache.delete(name);
    throw error;
  });
  registryCache.set(name, { at: Date.now(), promise });
  return promise;
}

function targetOf(registryPath) {
  const match = /^registry\/[^/]+\/(ui|hooks|lib|components)\/(.+)$/.exec(registryPath);
  if (!match) return null;
  return match[1] === 'ui' ? `components/ui/${match[2]}` : `${match[1]}/${match[2]}`;
}

function projectSource(content) {
  return content
    .replace(/from "cn"/g, 'from "@/lib/utils"')
    .replace(/@\/registry\/[^/"]+\/ui\//g, '@/components/ui/')
    .replace(/@\/registry\/[^/"]+\/hooks\//g, '@/hooks/')
    .replace(/@\/registry\/[^/"]+\/lib\//g, '@/lib/')
    .replace(/@\/registry\/[^/"]+\/components\//g, '@/components/');
}

function localImportsOf(source) {
  return [...source.matchAll(LOCAL_IMPORT)].map((match) => ({ relative: `${match[1]}/${match[2]}`, name: match[2] }));
}

export async function resolveLocalImports({ sources, planned }) {
  const queue = sources.flatMap(localImportsOf);
  const visited = new Set();
  const added = new Map();
  const unresolved = new Set();
  const dependencies = new Set();
  if (sources.some((source) => THEME_PROVIDER_IMPORT.test(source)) && !existsLocally('components/theme-provider') && !planned.has('components/theme-provider')) {
    added.set('components/theme-provider.tsx', THEME_PROVIDER_SOURCE);
  }
  while (queue.length > 0) {
    const { relative, name } = queue.shift();
    if (visited.has(relative) || existsLocally(relative) || planned.has(relative)) continue;
    visited.add(relative);
    if (visited.size > LIMITS.shadcnMaxItems) throw new ToolError('import_too_large', `more than ${LIMITS.shadcnMaxItems} shadcn components are needed`);
    let item;
    try {
      item = await registryItem(name);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== 'upstream_not_found') throw error;
      unresolved.add(`@/${relative}`);
      continue;
    }
    for (const file of item.files) {
      const target = targetOf(file.path);
      if (!target || added.has(target)) continue;
      const content = projectSource(String(file.content ?? ''));
      added.set(target, content);
      queue.push(...localImportsOf(content));
    }
    for (const dependency of item.registryDependencies ?? []) {
      if (typeof dependency === 'string' && ITEM_NAME.test(dependency)) queue.push({ relative: `components/ui/${dependency}`, name: dependency });
    }
    for (const dependency of item.dependencies ?? []) {
      if (dependency !== 'cn' && dependency !== 'react') dependencies.add(dependency);
    }
  }
  const missingPackages = [...dependencies].filter((name) => !fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', name.replace(/@[^/@]+$/, ''), 'package.json')));
  return {
    added: [...added].map(([relative, content]) => ({ relative, content })),
    unresolved: [...unresolved].sort(),
    missingPackages: missingPackages.sort(),
  };
}

export { withoutExtension };
