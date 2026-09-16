import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { include: ['@huggingface/tokenizers', 'onnxruntime-web/webgpu', 'pdfjs-dist', 'mammoth/mammoth.browser.js'] },
});
