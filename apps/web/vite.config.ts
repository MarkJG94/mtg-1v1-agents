import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs as a separate process; in Docker the server
    // serves this build itself, so no proxy is involved.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
