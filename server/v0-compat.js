import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { canonicalFileOf, isUnderApp, isUnderRootModules } from './appPaths.js';
import { languageOf } from './parseLanguage.js';
import { parseSafely } from './safeParse.js';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');
const APP_DIR = path.join(PROJECT_ROOT, 'app');
const SHIMS_DIR = path.join(SERVER_DIR, 'shims');

const LUCIDE_ICONS_SHIM_FILE = path.join(SHIMS_DIR, 'lucide-icons.tsx');
const LUCIDE_ICONS_SHIM_ID = LUCIDE_ICONS_SHIM_FILE.replaceAll('\\', '/');

const NEXT_SHIM_FILES = {
  'next/link': 'next-link.tsx',
  'next/image': 'next-image.tsx',
  'next/navigation': 'next-navigation.ts',
  'next/head': 'next-head.tsx',
  'next/dynamic': 'next-dynamic.tsx',
  'next/font/google': 'next-font.ts',
  'next/font/local': 'next-font.ts',
};

const NEXT_ROUTE_SEGMENT_EXPORTS = new Set([
  'metadata',
  'generateMetadata',
  'viewport',
  'generateViewport',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'generateStaticParams',
]);

const ROUTE_FILE_PATTERN = /[\\/]app[\\/](?:.*[\\/])?(?:page|layout|template|loading|error|not-found|global-error)\.[jt]sx?$/i;
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/i;
const BARE_TAILWIND_IMPORT_PATTERN = /@import\s+(['"])tailwindcss\1\s*;/g;

function isAppSource(id, pattern) {
  const file = canonicalFileOf(id);
  return file !== null && isUnderApp(file) && !isUnderRootModules(file) && pattern.test(file);
}

function toDestructuringEntry(specifier) {
  const imported = specifier.imported.name ?? specifier.imported.value;
  return imported === specifier.local.name ? imported : `${imported}: ${specifier.local.name}`;
}

function isGoogleFontImport(statement) {
  return statement.type === 'ImportDeclaration' && statement.source.value === 'next/font/google';
}

function rewriteGoogleFontImports(code, id) {
  let program;
  try {
    program = parseAst(code, { lang: languageOf(id.split('?')[0]) });
  } catch {
    return code;
  }
  let rewritten = code;
  for (const statement of program.body.filter(isGoogleFontImport).reverse()) {
    const entries = statement.specifiers
      .filter((specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
      .map(toDestructuringEntry);
    const destructuring = entries.length ? ` const { ${entries.join(', ')} } = __nextGoogleFonts;` : '';
    const replacement = `import { fonts as __nextGoogleFonts } from 'next/font/google';${destructuring}`;
    rewritten = rewritten.slice(0, statement.start) + replacement + rewritten.slice(statement.end);
  }
  return rewritten;
}

function declaredNames(statement) {
  const declaration = statement.declaration;
  if (!declaration) return [];
  if (declaration.type === 'FunctionDeclaration') return declaration.id ? [declaration.id.name] : [];
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.map((declarator) => declarator.id.name ?? null);
  }
  return [];
}

function isNextRouteSegmentExport(statement) {
  if (statement.type !== 'ExportNamedDeclaration') return false;
  const names = declaredNames(statement);
  return names.length > 0 && names.every((name) => NEXT_ROUTE_SEGMENT_EXPORTS.has(name));
}

function stripNextRouteSegmentExports(code, id) {
  const program = parseAst(code, { lang: languageOf(id.split('?')[0]) });
  const removable = program.body.filter(isNextRouteSegmentExport);
  if (!removable.length) return null;
  let stripped = code;
  for (const statement of removable.reverse()) {
    const blanked = stripped.slice(statement.start, statement.end).replace(/[^\r\n]/g, '');
    stripped = stripped.slice(0, statement.start) + blanked + stripped.slice(statement.end);
  }
  return stripped;
}

function preinstalledRadixPackages() {
  try {
    return readdirSync(path.join(PROJECT_ROOT, 'node_modules', '@radix-ui'))
      .filter((name) => name.startsWith('react-'))
      .map((name) => `@radix-ui/${name}`);
  } catch {
    return [];
  }
}

const PREBUNDLED_DEPENDENCIES = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'radix-ui',
  'lucide-react',
  'class-variance-authority',
  'clsx',
  'tailwind-merge',
  'sonner',
  'next-themes',
  'react-hook-form',
  '@hookform/resolvers/zod',
  'zod',
  'recharts',
  'date-fns',
  'cmdk',
  'vaul',
  'embla-carousel-react',
  'input-otp',
  'react-day-picker',
  'react-resizable-panels',
];

function nextShimsPlugin() {
  return {
    name: 'v0-compat:next-shims',
    enforce: 'pre',
    config() {
      return {
        resolve: {
          alias: [{ find: /^@\//, replacement: `${APP_DIR.replaceAll('\\', '/')}/` }],
        },
        optimizeDeps: {
          include: [...PREBUNDLED_DEPENDENCIES, ...preinstalledRadixPackages()],
        },
      };
    },
    resolveId(source) {
      const shimFile = NEXT_SHIM_FILES[source];
      return shimFile ? path.join(SHIMS_DIR, shimFile) : null;
    },
    transform(code, id) {
      if (!isAppSource(id, SOURCE_FILE_PATTERN)) return null;
      let transformed = code;
      if (transformed.includes('next/font/google')) transformed = rewriteGoogleFontImports(transformed, id);
      if (ROUTE_FILE_PATTERN.test(canonicalFileOf(id))) {
        transformed = stripNextRouteSegmentExports(transformed, id) ?? transformed;
      }
      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}

function lucideIconsCompatPlugin() {
  return {
    name: 'v0-compat:lucide-icons',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== 'lucide-react' || importer?.replaceAll('\\', '/').split('?')[0] === LUCIDE_ICONS_SHIM_ID) return null;
      return LUCIDE_ICONS_SHIM_FILE;
    },
  };
}

function tailwindSourceScopePlugin() {
  return {
    name: 'v0-compat:tailwind-source-scope',
    enforce: 'pre',
    transform(code, id) {
      if (!isAppSource(id, /\.css$/) || !code.includes('tailwindcss')) return null;
      const stylesheetDir = path.dirname(canonicalFileOf(id));
      const appRelative = path.relative(stylesheetDir, APP_DIR).replaceAll('\\', '/') || '.';
      const scoped = code.replace(BARE_TAILWIND_IMPORT_PATTERN, `@import "tailwindcss" source("${appRelative}");`);
      return scoped === code ? null : { code: scoped, map: null };
    },
  };
}

const VETTED_CACHE_LIMIT = 500;

function unparseableSourceGatePlugin() {
  const verdicts = new Map();
  return {
    name: 'v0-compat:unparseable-source-gate',
    enforce: 'pre',
    async transform(code, id) {
      if (!isAppSource(id, SOURCE_FILE_PATTERN)) return null;
      const file = canonicalFileOf(id);
      const language = languageOf(file);
      if (language === null) return null;
      let signature;
      try {
        const stats = statSync(file);
        signature = `${stats.mtimeMs}:${stats.size}:${code.length}`;
      } catch {
        signature = `${code.length}`;
      }
      const known = verdicts.get(file);
      let verdict = known?.signature === signature ? known.verdict : undefined;
      if (verdict === undefined) {
        const parsed = await parseSafely(code, language);
        if (parsed.crashed && parsed.transient) this.error(`${path.relative(PROJECT_ROOT, file)} could not be checked because the safe parse check is unavailable (${parsed.reason}); the next request retries`);
        verdict = parsed.crashed ? `too large or too deeply nested to compile safely (${parsed.reason}); simplify or split the file` : '';
        verdicts.delete(file);
        verdicts.set(file, { signature, verdict });
        while (verdicts.size > VETTED_CACHE_LIMIT) verdicts.delete(verdicts.keys().next().value);
      }
      if (verdict !== '') this.error(`${path.relative(PROJECT_ROOT, file)} is ${verdict}`);
      return null;
    },
  };
}

export function v0Compat() {
  return [unparseableSourceGatePlugin(), nextShimsPlugin(), lucideIconsCompatPlugin(), tailwindSourceScopePlugin(), tailwindcss(), react()];
}
