/**
 * Levanta la app contra los datos de `fixtures.mjs`, aislada de la maquina.
 *
 * La app lee tres cosas del entorno y las tres se apuntan a la carpeta de demo:
 * el home (`~/.claude/projects`, `~/.claude/sessions` y `CODEX_HOME`), el
 * directorio de configuracion propio (`workspace.json`, notas, archivadas) y el
 * `PATH`, filtrado para que no aparezca ninguna CLI de verdad y con la simulada
 * primera (`isolation.mjs`). No hay ningun modo especial en el servidor: corre
 * el mismo codigo que en uso normal, con otro entorno.
 *
 * En Windows la carpeta se monta como unidad `W:` con `subst`, para que ninguna
 * ruta de las capturas lleve el usuario de la maquina; en macOS y Linux vive en
 * el directorio temporal, que tampoco lo lleva.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures } from './fixtures.mjs';
import {
  assertDemoPath,
  availableAgentsFromStartup,
  demoEnvironment,
  historyLinesFromStartup,
  startupBlockComplete,
} from './isolation.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWindows = process.platform === 'win32';
const DRIVE = 'W:';

/** Genera los datos y devuelve donde quedaron y con que rutas los ve la app. */
export function prepareDemo() {
  const base = path.join(tmpdir(), 'agent-workbench-demo');
  const root = path.join(base, 'root');
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const configDir = isWindows
    ? path.join(home, 'AppData', 'Roaming', 'agent-workbench')
    : path.join(home, '.config', 'agent-workbench');
  const projectsRoot = isWindows ? `${DRIVE}\\Proyectos` : path.join(root, 'Proyectos');
  const fixtures = buildFixtures({ root, home, bin, configDir, projectsRoot });
  return { root, home, bin, configDir, projectsRoot, ...fixtures };
}

function mountDrive(root) {
  if (!isWindows) return () => {};
  if (existsSync(`${DRIVE}\\`)) {
    // Una corrida anterior que murio sin limpiar deja la unidad montada. Si
    // apunta a nuestra carpeta se desmonta y se sigue; si es de otra cosa, no.
    const mapping = execFileSync('subst', { encoding: 'utf8' })
      .split(/\r?\n/)
      .find((line) => line.toUpperCase().startsWith(`${DRIVE}\\: => `));
    const target = mapping?.slice(`${DRIVE}\\: => `.length).trim();
    if (target === undefined || path.resolve(target).toLowerCase() !== path.resolve(root).toLowerCase()) {
      throw new Error(`La unidad ${DRIVE} ya existe y no es de la demo. Liberala o cambia DRIVE en scripts/demo/environment.mjs.`);
    }
    execFileSync('subst', [DRIVE, '/D']);
  }
  execFileSync('subst', [DRIVE, root]);
  return () => {
    try {
      execFileSync('subst', [DRIVE, '/D']);
    } catch {
      // Ya no estaba montada.
    }
  };
}

/**
 * Arranca el servidor con el entorno de demo.
 *
 * @param {{ mode: 'dev' | 'prod', openBrowser: boolean }} options
 *   `prod` sirve `packages/web/dist` y necesita un `pnpm build` previo; `dev`
 *   monta Vite y recarga en caliente.
 * @returns {Promise<{ url: string, availableAgents: string[], historyLines: string[], demo: ReturnType<typeof prepareDemo>, stop: () => void }>}
 *   `availableAgents`: los ids de la linea `CLIs disponibles` del arranque.
 *   `historyLines`: las lineas `Historial` del arranque (una base de otra CLI).
 */
export async function startDemoServer({ mode, openBrowser }) {
  if (mode === 'prod' && !existsSync(path.join(repoRoot, 'packages', 'web', 'dist', 'index.html'))) {
    throw new Error('Falta packages/web/dist: corre "pnpm build" antes.');
  }

  const demo = prepareDemo();

  const env = demoEnvironment(process.env, { home: demo.home, bin: demo.bin, mainCwd: demo.mainCwd });
  if (!openBrowser) env['AGENT_WORKBENCH_NO_OPEN'] = '1';
  // Antes de montar nada: si la demo ve una CLI de verdad, no se arranca.
  assertDemoPath(demo.bin, env['PATH']);

  const unmount = mountDrive(demo.root);

  /*
    El mismo Node que corre este script, con el CLI de `tsx` del servidor: lo
    mismo que hace `pnpm dev` / `pnpm start`, sin necesitar `pnpm` ni `node` en
    el PATH filtrado (ver `isolation.mjs`).
  */
  const serverDir = path.join(repoRoot, 'packages', 'server');
  const tsxCli = createRequire(path.join(serverDir, 'package.json')).resolve('tsx/cli');
  const server = spawn(process.execPath, [tsxCli, 'src/index.ts', ...(mode === 'prod' ? ['--prod'] : [])], {
    cwd: serverDir,
    env,
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      if (isWindows) execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-server.pid, 'SIGTERM');
    } catch {
      // Ya habia terminado.
    }
    unmount();
  };
  process.on('exit', stop);

  /*
    Se espera la URL y el bloque de arranque entero: la linea `CLIs disponibles`
    y las de `Historial` las imprime el mismo arranque, pero pueden llegar en
    otro trozo de la salida. Sin ellas no se sabe que CLIs ni que historiales
    vio el servidor.
  */
  const { url, availableAgents, historyLines } = await new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      stop();
      reject(new Error('El servidor no imprimio la URL y las CLIs disponibles en 60 s.'));
    }, 60_000);
    server.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (settled) return;
      buffer += chunk.toString();
      const match = buffer.match(/URL\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      const agents = availableAgentsFromStartup(buffer);
      if (match !== null && agents !== null && startupBlockComplete(buffer)) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[1], availableAgents: agents, historyLines: historyLinesFromStartup(buffer) });
      }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.on('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`El servidor termino con codigo ${code} antes de imprimir la URL.`));
    });
  });

  return { url, availableAgents, historyLines, demo, stop };
}
