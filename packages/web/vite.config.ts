import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packageDir, '../..');
// La version de la app, para el cartel de apoyo (§6.28): la del package.json de la raiz.
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(rootPkg.version) },
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
