import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { sizeBudget } from './build-config/sizeBudget';
import { vendorChunk } from './build-config/vendorChunks';

/*
 * Gzipped ceilings, with roughly 15% headroom over where the bundle sits
 * today. Deliberately tight: the headroom is for a feature, not for a fifth
 * charting library. Raising these is fine and is meant to be an argument
 * somebody makes in a pull request rather than a number that quietly drifts.
 */
const SIZE_BUDGET = { initial: 170_000, total: 290_000 };

export default defineConfig({
  plugins: [react(), tailwindcss(), sizeBudget(SIZE_BUDGET)],
  build: {
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Same-origin in development, so the session cookie needs no CORS or
      // SameSite=None dance. This proxy is the dev-only equivalent of what the
      // API does for itself in production, where it serves `dist` and answers
      // /api from the same origin.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
});
