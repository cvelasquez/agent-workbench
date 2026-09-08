/**
 * Levanta la app contra los datos de `fixtures.mjs`, aislada de la maquina.
 *
 * La app lee tres cosas del entorno y las tres se apuntan a la carpeta de demo:
 * el home (`~/.claude/projects` y `~/.claude/sessions`), el directorio de
 * configuracion propio (`workspace.json`, notas, archivadas) y el `PATH`, donde
 * la CLI simulada va primera. No hay ningun modo especial en el servidor: corre
 * el mismo codigo que en uso normal, con otro entorno.
 *
 * En Windows la carpeta se monta como unidad `W:` con `subst`, para que ninguna
 * ruta de las capturas lleve el usuario de la maquina; en macOS y Linux vive en
 * el directorio temporal, que tampoco lo lleva.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtures } from './fixtures.mjs';

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
 * @returns {Promise<{ url: string, demo: ReturnType<typeof prepareDemo>, stop: () => void }>}
 */
export async function startDemoServer({ mode, openBrowser }) {
  if (mode === 'prod' && !existsSync(path.join(repoRoot, 'packages', 'web', 'dist', 'index.html'))) {
    throw new Error('Falta packages/web/dist: corre "pnpm build" antes.');
  }

  const demo = prepareDemo();
  const unmount = mountDrive(demo.root);

  const env = {
    ...process.env,
    HOME: demo.home,
    USERPROFILE: demo.home,
    APPDATA: path.join(demo.home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(demo.home, '.config'),
    PATH: `${demo.bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
    AGENT_WORKBENCH_CWD: demo.mainCwd,
  };
  if (!openBrowser) env['AGENT_WORKBENCH_NO_OPEN'] = '1';
  // Corrido desde una sesion de la CLI, el marcador heredado hace que la app
  // muestre el aviso de CLAUDE.md 4.10, y saldria en las capturas.
  delete env['CLAUDE_CODE_CHILD_SESSION'];

  const server = spawn('pnpm', [mode === 'prod' ? 'start' : 'dev'], {
    cwd: repoRoot,
    env,
    shell: true,
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
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

  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      stop();
      reject(new Error('El servidor no imprimio la URL en 60 s.'));
    }, 60_000);
    server.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      buffer += chunk.toString();
      const match = buffer.match(/URL\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`El servidor termino con codigo ${code} antes de imprimir la URL.`));
    });
  });

  return { url, demo, stop };
}
