/**
 * `pnpm demo`: la app con proyectos y conversaciones inventadas, para verla
 * funcionar sin exponer nada propio o para trabajar en la interfaz con datos
 * estables. Corre en modo desarrollo (Vite, recarga en caliente) y abre el
 * navegador. Ctrl+C la termina y desmonta la unidad.
 */
import { startDemoServer } from './environment.mjs';

const { url, demo, stop } = await startDemoServer({ mode: 'dev', openBrowser: true });
console.log(`\nDemo corriendo en ${url}`);
console.log(`Proyectos en ${demo.projectsRoot}. Ctrl+C para terminar.\n`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
}
