import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// GitHub Pages serves from /workflow-poc/, Vercel serves from the root.
// Set DEPLOY_TARGET=pages in the Pages build; default (Vercel/local) uses '/'.
const base = process.env.DEPLOY_TARGET === 'pages' ? '/workflow-poc/' : '/';

export default defineConfig({
  plugins: [react()],
  base,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        worker: resolve(__dirname, 'worker.html'),
      },
    },
  },
});
