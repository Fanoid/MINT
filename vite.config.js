import { defineConfig } from 'vite';

export default defineConfig({
  base: '/MINT/',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 3000,
    open: true,
  },
});
