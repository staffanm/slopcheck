import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { include: ['@huggingface/tokenizers', 'onnxruntime-web/webgpu', 'pdfjs-dist', 'mammoth/mammoth.browser.js'] },
  server: {
    // Normal mode calls /api/match and /match. In dev, proxy them to the
    // deployed backend (override with SLOPCHECK_BACKEND). Integritetsläge needs no backend.
    proxy: Object.fromEntries(['/api', '/match', '/health'].map(path => [path, {
      target: process.env.SLOPCHECK_BACKEND || 'https://slopcheck.tomtebo.org',
      changeOrigin: true,
    }])),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        about: resolve(import.meta.dirname, 'sa-funkar-det.html'),
        disclaimer: resolve(import.meta.dirname, 'ansvarsfriskrivning.html'),
      },
    },
  },
});
