import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageDir, '../..');

export default defineConfig({
  plugins: [react()],
  server: {
    // El servidor de Agent Workbench monta Vite como middleware, asi que la raiz
    // de Vite es packages/web pero necesita leer packages/shared.
    fs: { allow: [repoRoot] },
  },
  resolve: {
    // El paquete shared se consume como fuente TypeScript, sin paso de build.
    preserveSymlinks: false,
  },
  optimizeDeps: {
    exclude: ['@agent-workbench/shared'],
  },
});
