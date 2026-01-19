import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(ROOT_DIR, 'apps/web/src'),
    },
  },
  build: {
    outDir: path.resolve(ROOT_DIR, 'dist/web'),
    emptyOutDir: true,
  },
  publicDir: false,
});
