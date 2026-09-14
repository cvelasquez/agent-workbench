/**
 * Que la demo no vea ninguna CLI de verdad.
 *
 * Las capturas del README salen de datos inventados (CLAUDE.md 7.3). Desde que
 * la app localiza mas de una CLI, eso ya no alcanza con un home falso: si la
 * demo encuentra Codex en el `PATH`, el menu de CLIs y las insignias salen en
 * las capturas, y con su `CODEX_HOME` real saldria su historial.
 *
 * Por eso el servidor de la demo arranca con un `PATH` **filtrado**: sin
 * ninguna carpeta que contenga un comando de agente, con la CLI simulada
 * primera. Y se lanza con el mismo Node que corre este script, sin `pnpm` ni
 * shell: la carpeta de Node suele ser la del prefijo global de npm, que es
 * justo donde `npm i -g` deja `codex.cmd`, y sacarla del `PATH` dejaria sin
 * `node` a cualquier cosa que lo buscara ahi.
 *
 * Todo aca es puro o de solo lectura: lo prueba `check-codex-adapter.mjs`.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';

/** Los comandos de agente que la demo no puede encontrar, salvo la CLI simulada. */
export const AGENT_COMMANDS = ['codex', 'opencode', 'agy', 'claude'];

/** Lo que la demo necesita del `PATH` real: el panel de git de las capturas. */
export const REQUIRED_COMMANDS = ['git'];

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Los nombres de archivo con que se busca un comando, con la misma regla que
 * `packages/server/src/agents/locate.ts`: en Windows, el comando con cada
 * extension de `PATHEXT` y nunca pelado; en los demas, pelado.
 */
function candidateNames(command, { platform, pathext }) {
  if (platform !== 'win32') return [command];
  return (pathext ?? DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'))
    .map((extension) => command + extension);
}

function isUsableFile(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Las entradas de un `PATH`, sin vacias y sin las comillas que Windows permite. */
export function pathEntries(pathValue, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  return (pathValue ?? '')
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * Donde resuelve un comando con ese `PATH`, o null. Copia de `findInPath` de
 * `agents/locate.ts`, que no se puede importar desde un script sin TypeScript.
 */
export function findInPath(command, pathValue, { platform = process.platform, pathext = process.env['PATHEXT'] } = {}) {
  for (const directory of pathEntries(pathValue, platform)) {
    for (const name of candidateNames(command, { platform, pathext })) {
      const candidate = path.join(directory, name);
      if (isUsableFile(candidate, platform)) return path.resolve(candidate);
    }
  }
  return null;
}

/**
 * El `PATH` de la demo: la carpeta de la CLI simulada y, detras, las entradas
 * del original que no contienen ningun comando de agente.
 */
export function demoPath(bin, pathValue, { platform = process.platform, pathext = process.env['PATHEXT'] } = {}) {
  const kept = pathEntries(pathValue, platform).filter((directory) =>
    AGENT_COMMANDS.every((command) =>
      candidateNames(command, { platform, pathext }).every((name) => !isUsableFile(path.join(directory, name), platform)),
    ),
  );
  return [bin, ...kept].join(platform === 'win32' ? ';' : ':');
}

/** true si `candidate` cae dentro de `root`. En Windows `path.relative` ya no distingue mayusculas. */
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Lanza si con ese `PATH` la demo veria una CLI de verdad, o no veria lo que
 * necesita: ningun comando de agente salvo `claude`, y `claude` dentro de la
 * carpeta de la CLI simulada; `git`, en algun lado.
 */
export function assertDemoPath(bin, pathValue, options = {}) {
  for (const command of AGENT_COMMANDS) {
    const found = findInPath(command, pathValue, options);
    if (command === 'claude') {
      if (found === null || !isInside(bin, found)) {
        throw new Error(`La demo no encontro su CLI simulada en ${bin}${found === null ? '' : ` (encontro ${found})`}. No se arranca: saldria la CLI de verdad en las capturas.`);
      }
      continue;
    }
    if (found !== null) {
      throw new Error(`La demo encontro ${command} en ${path.dirname(found)}. No se arranca: saldria en las capturas.`);
    }
  }
  for (const command of REQUIRED_COMMANDS) {
    if (findInPath(command, pathValue, options) === null) {
      throw new Error(`La demo no encuentra ${command} en el PATH filtrado: quedo en una carpeta junto a un comando de agente. Las capturas del panel de cambios saldrian rotas.`);
    }
  }
}

/**
 * El entorno del servidor de la demo: todo lo que la app lee del home, de la
 * configuracion propia y de las CLIs, apuntado a la carpeta de la demo.
 *
 * En Windows las claves del entorno no distinguen mayusculas y el original
 * suele traer `Path`: se borran las variantes antes de poner la nueva, para no
 * depender de cual gana al lanzar.
 */
export function demoEnvironment(base, { home, bin, mainCwd, platform = process.platform, pathext = base['PATHEXT'] }) {
  const env = { ...base };
  const set = (key, value) => {
    if (platform === 'win32') {
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
      }
    }
    env[key] = value;
  };
  const originalPath = Object.entries(base).find(([key]) => (platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH'))?.[1];

  set('HOME', home);
  set('USERPROFILE', home);
  set('APPDATA', path.join(home, 'AppData', 'Roaming'));
  set('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
  set('XDG_CONFIG_HOME', path.join(home, '.config'));
  set('XDG_DATA_HOME', path.join(home, '.local', 'share'));
  set('XDG_CACHE_HOME', path.join(home, '.cache'));
  set('XDG_STATE_HOME', path.join(home, '.local', 'state'));
  set('CODEX_HOME', path.join(home, '.codex'));
  set('PATH', demoPath(bin, originalPath, { platform, pathext }));
  set('AGENT_WORKBENCH_CWD', mainCwd);
  /*
    Corrido desde una sesion de la CLI, el marcador heredado hace que la app
    muestre el aviso de CLAUDE.md 4.10, y saldria en las capturas. Las demas
    apuntarian a la base, el catalogo o la configuracion reales de otras CLIs:
    una variable del shell del usuario meteria su historial en las imagenes.
  */
  for (const key of [
    'CLAUDE_CODE_CHILD_SESSION',
    'CODEX_SQLITE_HOME',
    'OPENCODE_DB',
    'OPENCODE_MODELS_PATH',
    'OPENCODE_MODELS_URL',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
  ]) set(key, undefined);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

/**
 * Lanza si el servidor de la demo no vio exactamente la CLI simulada: con
 * cualquier otra, el menu de CLIs y su historial saldrian en las capturas; sin
 * ninguna, el cartel de "no encontrada".
 */
export function assertOnlySimulatedAgent(availableAgents) {
  if (availableAgents.length === 1 && availableAgents[0] === 'claude-code') return;
  const seen = availableAgents.length === 0 ? 'ninguna CLI' : availableAgents.join(', ');
  throw new Error(`La demo vio ${seen} en vez de solo la CLI simulada. No se capturan: saldria en las imagenes.`);
}

/**
 * true si el servidor ya imprimio el bloque de arranque entero. `Consola` es la
 * ultima linea que no depende de nada, y va despues de las de las CLIs y del
 * historial: esperar solo `CLIs disponibles` podia dejar afuera la del
 * historial, que llega en otro trozo de la salida.
 */
export function startupBlockComplete(output) {
  return /^\s*Consola\s/m.test(output);
}

/** Las lineas `Historial` del arranque: una base de verdad que el servidor va a leer. */
export function historyLinesFromStartup(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^Historial\b/.test(line));
}

/**
 * Lanza si el servidor de la demo anuncio un historial de otra CLI: con una
 * base de verdad a mano, sus sesiones saldrian en la barra de las capturas
 * aunque la CLI no este en el `PATH` (hito 26).
 */
export function assertNoNativeHistory(historyLines) {
  if (historyLines.length === 0) return;
  throw new Error(`La demo va a leer un historial de verdad (${historyLines.join(' | ')}). No se capturan: saldria en las imagenes.`);
}

/**
 * Los ids de la linea `CLIs disponibles` que imprime el servidor al arrancar,
 * o null si todavia no la imprimio.
 */
export function availableAgentsFromStartup(output) {
  const match = /^\s*CLIs disponibles\s+(.+?)\s*$/m.exec(output);
  if (match === null) return null;
  const value = match[1];
  return value === 'ninguna' ? [] : value.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
}
