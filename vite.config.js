import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { hmrLivePlugin } from './server/plugin.js';
import { v0Compat } from './server/v0-compat.js';

export default defineConfig(({ command }) => ({
  appType: 'mpa',
  publicDir: command === 'build' ? resolve('app/public') : false,
  plugins: [hmrLivePlugin(), ...v0Compat()],
  server: {
    watch: {
      ignored: ['**/.gm/**', '**/.hmr-live/**', '**/.agentplug*/**', '**/.env'],
    },
  },
  build: {
    rollupOptions: {
      input: {
        launcher: resolve('index.html'),
        app: resolve('app/index.html'),
        live: resolve('live/index.html'),
      },
    },
  },
}));
