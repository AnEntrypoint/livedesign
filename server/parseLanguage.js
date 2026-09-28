import path from 'node:path';

const LANGUAGE_BY_EXTENSION = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
};

export function languageOf(filePath) {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}
