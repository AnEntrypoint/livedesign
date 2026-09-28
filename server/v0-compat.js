import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');
const APP_DIR = path.join(PROJECT_ROOT, 'app');
const SHIMS_DIR = path.join(SERVER_DIR, 'shims');

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

const PARSER_LANGUAGE_BY_EXTENSION = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
};

const ROUTE_FILE_PATTERN = /[\\/]app[\\/](?:.*[\\/])?(?:page|layout|template|loading|error|not-found|global-error)\.[jt]sx?$/;
const SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const GOOGLE_FONT_IMPORT_PATTERN = /import\s*\{([^}]*)\}\s*from\s*(['"])next\/font\/google\2;?/g;
const BARE_TAILWIND_IMPORT_PATTERN = /@import\s+(['"])tailwindcss\1\s*;/g;

function isAppSource(id, pattern) {
  const file = path.normalize(id.split('?')[0]);
  return file.startsWith(APP_DIR + path.sep) && !file.includes('node_modules') && pattern.test(file);
}

function toDestructuringEntry(specifier) {
  const renamed = specifier.match(/^(\S+)\s+as\s+(\S+)$/);
  return renamed ? `${renamed[1]}: ${renamed[2]}` : specifier;
}

function rewriteGoogleFontImports(code) {
  return code.replace(GOOGLE_FONT_IMPORT_PATTERN, (_match, specifierList) => {
    const entries = specifierList
      .split(',')
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier && !specifier.startsWith('type '))
      .map(toDestructuringEntry);
    const destructuring = entries.length ? ` const { ${entries.join(', ')} } = __nextGoogleFonts;` : '';
    return `import { fonts as __nextGoogleFonts } from 'next/font/google';${destructuring}`;
  });
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
  const program = parseAst(code, { lang: PARSER_LANGUAGE_BY_EXTENSION[path.extname(id.split('?')[0])] });
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
      if (transformed.includes('next/font/google')) transformed = rewriteGoogleFontImports(transformed);
      if (ROUTE_FILE_PATTERN.test(id.split('?')[0])) {
        transformed = stripNextRouteSegmentExports(transformed, id) ?? transformed;
      }
      return transformed === code ? null : { code: transformed, map: null };
    },
  };
}

function tailwindSourceScopePlugin() {
  return {
    name: 'v0-compat:tailwind-source-scope',
    enforce: 'pre',
    transform(code, id) {
      if (!isAppSource(id, /\.css$/) || !code.includes('tailwindcss')) return null;
      const stylesheetDir = path.dirname(id.split('?')[0]);
      const appRelative = path.relative(stylesheetDir, APP_DIR).replaceAll('\\', '/') || '.';
      const scoped = code.replace(BARE_TAILWIND_IMPORT_PATTERN, `@import "tailwindcss" source("${appRelative}");`);
      return scoped === code ? null : { code: scoped, map: null };
    },
  };
}

export function v0Compat() {
  return [nextShimsPlugin(), tailwindSourceScopePlugin(), tailwindcss(), react()];
}
