import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/workflow-poc/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        worker: resolve(__dirname, 'worker.html'),
      },
    },
  },
});
