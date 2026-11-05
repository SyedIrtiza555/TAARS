import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const backend = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: '../public/admin',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // changeOrigin must stay false: the API's origin guard compares the
      // browser Origin header with the Host header it receives.
      '^/api': { target: backend, changeOrigin: false },
    },
  },
});
