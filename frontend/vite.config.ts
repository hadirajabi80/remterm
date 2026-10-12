import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2021', chunkSizeWarningLimit: 1000 },
  server: { port: Number(process.env.PORT) || 5173 },
});
