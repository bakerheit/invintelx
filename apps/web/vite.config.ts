import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

/**
 * Baked in so a browser error report can say which build produced it — a tab
 * left open across a deploy is running code the server no longer has. Read from
 * this package's manifest, which `scripts/release/check-release.mjs` keeps equal
 * to the tag and therefore equal to the version the API reports at /health.
 */
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
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
