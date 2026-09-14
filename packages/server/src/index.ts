/**
 * Arranque de Agent Workbench.
 *
 * Un solo proceso: sirve la UI y el WebSocket en el mismo puerto. Eso no es
 * casualidad — con un unico origen, el chequeo de Origin y el token funcionan
 * igual en desarrollo y en produccion, sin excepciones que despues se olvidan
 * de sacar.
 */

import { existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { TOKEN_QUERY_PARAM, type AgentInfo } from '@agent-workbench/shared';
import { ArchivedSessions } from './archived-sessions.js';
import { createAgentRegistry, type AgentRegistry } from './agents/registry.js';
import { migrateLegacyConfigDir } from './config-dir-migration.js';
import { ConversationHub } from './conversation-hub.js';
import { openBrowser } from './open-browser.js';
import {
  LOOPBACK_HOST,
  buildTokenCookie,
  createSessionToken,
  hasValidHost,
  hasValidOrigin,
  matchToken,
} from './security.js';
import { appConfigDir } from './paths.js';
import { RepoHub } from './repo-hub.js';
import { MemoryHub } from './memory-hub.js';
import { PasteStore } from './paste-store.js';
import { SessionIndex } from './session-index.js';
import { startupAgentLines } from './startup-summary.js';
import { NotesStore } from './notes-store.js';
import { locateShell, type ShellLocation } from './shell-locator.js';
import { watchSessions } from './session-watcher.js';
import { TerminalRegistry } from './terminal-registry.js';
import { attachTerminalSocket } from './terminal-socket.js';
import { WorkspaceStore } from './workspace-store.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Verdadero solo dentro del paquete que se publica en npm. Lo inyecta esbuild
 * al empaquetar (`scripts/build-npm.mjs`); corriendo desde el repositorio la
 * variable no existe, y `typeof` sobre algo no declarado responde `undefined`
 * en vez de lanzar.
 *
 * Se decide al compilar y no mirando el disco, por lo mismo que `isProduction`
 * mas abajo: "si existe tal carpeta, entonces…" es justo lo que hace que un dia
 * arranque distinto sin que nadie sepa por que.
 *
 * Cambia tres cosas, las tres porque un paquete instalado no es este
 * repositorio: la interfaz compilada viaja al lado del servidor en vez de
 * `packages/web/dist`; el directorio por defecto es desde donde el usuario
 * corrio el comando; y no hay modo desarrollo que ofrecer, porque el paquete no
 * lleva ni las fuentes de la interfaz ni Vite.
 */
declare const __PACKAGED__: boolean | undefined;
const isPackaged = typeof __PACKAGED__ !== 'undefined' && __PACKAGED__ === true;

const webRoot = isPackaged ? serverDir : path.resolve(serverDir, '../../web');
const webDist = isPackaged ? path.join(serverDir, 'web') : path.join(webRoot, 'dist');
const repoRoot = path.resolve(serverDir, '../../..');

/**
 * Modo de servido de la interfaz.
 *
 * Explicito y no adivinado. La alternativa —"si existe `dist/`, servirlo"—
 * parece comoda hasta que alguien corre `pnpm build` una vez y a partir de ahi
 * `pnpm dev` deja de recargar en caliente sin decir por que.
 *
 * `pnpm dev` monta Vite; `pnpm start` sirve los archivos ya compilados.
 */
const isProduction = isPackaged || process.argv.includes('--prod');

/** Sugerencia de directorio para la primera pestana. */
function resolveDefaultCwd(): string {
  const override = process.env['AGENT_WORKBENCH_CWD'];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  // Instalado desde npm, el comando se corre parado en el proyecto donde se va
  // a trabajar, y eso es exactamente `process.cwd()`. Desde el repositorio no
  // sirve: pnpm ejecuta el script dentro de packages/server.
  if (isPackaged) return process.cwd();
  return repoRoot;
}

/**
 * Guardia unica para todas las rutas HTTP.
 *
 * El token llega por query la primera vez (la URL que abrimos) y despues por
 * cookie, porque los assets del SPA no pueden llevarlo en la URL.
 */
function createAuthMiddleware(port: number, token: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!hasValidHost(request, port) || !hasValidOrigin(request, port)) {
      response.status(403).type('text/plain').send('Origen no permitido.');
      return;
    }

    const match = matchToken(request, token);
    if (match === null) {
      response
        .status(401)
        .type('text/plain')
        .send('Falta el token de sesion. Abri la URL que imprimio el servidor al arrancar.');
      return;
    }

    if (match.source === 'query') {
      response.setHeader('Set-Cookie', buildTokenCookie(token));
    }
    next();
  };
}

/** Monta Vite como middleware. El HMR viaja por el mismo servidor HTTP. */
async function mountDevUi(
  app: express.Express,
  httpServer: HttpServer,
): Promise<() => Promise<void>> {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: webRoot,
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  app.use(vite.middlewares);
  return () => vite.close();
}

/**
 * Sirve la interfaz ya compilada.
 *
 * Vite no se importa siquiera en este camino: en produccion no tiene por que
 * estar instalado.
 *
 * El `sendFile` del final es el fallback de una SPA, y **solo** se aplica a
 * rutas que no piden un archivo. Un fallback que atrapa todo es el error
 * clasico de esta configuracion: un asset que falta devuelve el HTML con
 * estado 200, el navegador intenta interpretar `<!doctype html>` como
 * JavaScript y el error que se ve es un `Unexpected token '<'` que no tiene
 * nada que ver con la causa. Pasa de verdad — con un fragmento cargado a
 * demanda, como el resaltador de sintaxis, basta con recompilar mientras
 * alguien tiene la pagina abierta.
 *
 * Se detecta por la extension del ultimo segmento: si la ruta pide un archivo
 * y `express.static` no lo encontro, no existe, y eso es un 404.
 */
const LOOKS_LIKE_FILE = /\.[a-zA-Z0-9]{1,8}$/;

function mountBuiltUi(app: express.Express): () => Promise<void> {
  const indexHtml = path.join(webDist, 'index.html');
  if (!existsSync(indexHtml)) {
    throw new Error(
      `No hay interfaz compilada en ${webDist}.
Corre "pnpm build" antes de "pnpm start", o usa "pnpm dev".`,
    );
  }

  app.use(express.static(webDist, { index: false, maxAge: 0 }));
  app.get(/.*/, (request: Request, response: Response) => {
    if (LOOKS_LIKE_FILE.test(request.path)) {
      response.status(404).type('text/plain').send('No encontrado.');
      return;
    }
    response.sendFile(indexHtml);
  });

  return () => Promise.resolve();
}

/**
 * Lo que se imprime al arrancar.
 *
 * Las lineas de las CLIs cuentan las **disponibles** (`startup-summary.ts`): con
 * una sola instalada son las de siempre, aunque haya mas registradas.
 */
function describeStartup(
  url: string,
  cwd: string,
  agents: AgentRegistry,
  shell: ShellLocation | null,
): void {
  const agentList: readonly AgentInfo[] = agents.list();
  const line = '-'.repeat(64);
  console.log(`\n${line}`);
  console.log('  Agent Workbench');
  console.log(line);
  console.log(`  URL          ${url}`);
  console.log(`  Modo         ${isProduction ? 'produccion (interfaz compilada)' : 'desarrollo'}`);
  console.log(`  Directorio   ${cwd}`);
  const startupAgents = agentList.map((info) => ({
    id: info.id,
    label: info.label,
    version: info.version,
    resolvedPath: agents.get(info.id)?.location?.resolvedPath ?? null,
    missingMessage: info.missingMessage,
    historyNote: agents.get(info.id)?.adapter.startupHistoryNote?.(info.available) ?? null,
    // Solo la CLI con status line opcional; se imprime debajo de ella si esta instalada.
    statusLine: info.statusLine?.state ?? null,
  }));
  for (const agentLine of startupAgentLines(startupAgents)) console.log(agentLine);
  console.log(`  Consola      ${shell === null ? 'no encontrada' : shell.file}`);
  if (agentList.some((info) => info.environmentNotice === 'child-session-marker')) {
    console.log('');
    console.log('  Nota: este proceso heredo CLAUDE_CODE_CHILD_SESSION, que apaga el');
    console.log('  guardado del historial. Se quita del entorno de las pestanas para');
    console.log('  que el historial y la vista de conversacion funcionen igual.');
  }
  console.log(`${line}\n`);
}

async function main(): Promise<void> {
  const token = createSessionToken();
  const defaultCwd = resolveDefaultCwd();
  // Buscar las CLIs no bloquea el arranque: si falta, la UI lo explica. La
  // consola del panel derecho se busca a la vez y es opcional: sin ella el
  // resto de la app funciona igual.
  const agents = createAgentRegistry();
  const [, shell] = await Promise.all([agents.locateAll(), locateShell()]);

  // Antes de que nadie lea la configuracion: si quedo en el directorio del
  // nombre viejo, se mueve al nuevo (ver `config-dir-migration.ts`).
  const movedFrom = await migrateLegacyConfigDir();
  if (movedFrom !== null) console.log(`Configuracion movida de ${movedFrom} a ${appConfigDir()}`);
  // Lo que cada CLI encontrada instala en la carpeta de la app: recien ahora,
  // con la carpeta ya en su lugar (A1 del hito 27).
  await agents.prepareAll();

  const store = new WorkspaceStore();
  // Que sesiones escondio el usuario de la barra lateral. Se carga antes del
  // indice: si no, el primer envio las mostraria todas y desapareceria solas.
  const archived = new ArchivedSessions();
  await archived.load();
  /*
    El indice lee el historial de cada CLI a traves de su adaptador, y al leer
    le ensena al adaptador lo que haga falta —con Claude Code, que variante de
    modelo usa la instalacion—. Va antes que el registro de terminales porque
    le dice de que CLI es una sesion que se reanuda.
  */
  const index = new SessionIndex(agents, archived);
  const registry = new TerminalRegistry(agents, shell, store, (sessionId) =>
    index.agentOf(sessionId),
  );
  // Notas sueltas del usuario. Se cargan antes de aceptar conexiones: el
  // primer mensaje de cada socket ya lleva la lista.
  const notes = new NotesStore();
  await notes.load();
  /*
    Las conversaciones siguen cada sesion con el seguidor de su adaptador, y
    avisan que la CLI espera algo con el estado que publica ese mismo adaptador.
    El vigilante de estado y el registro de variantes son de cada adaptador y
    nadie mas los construye: un solo sondeo por CLI, y el medidor ve lo que
    aprendio el indice.
  */
  const conversations = new ConversationHub(registry, agents);
  const repos = new RepoHub(registry);
  // Memoria compartida de cada proyecto: `.agents/memory/`. Es lo unico que
  // escribe dentro de un proyecto, y solo cuando el usuario lo confirma.
  const memory = new MemoryHub(registry);
  const pasteStore = new PasteStore();

  const app = express();
  app.disable('x-powered-by');

  const httpServer = createServer(app);

  // Puerto efimero en loopback. Nunca 0.0.0.0.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, LOOPBACK_HOST, resolve);
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('No se pudo determinar el puerto asignado.');
  }
  const { port } = address;

  app.use(createAuthMiddleware(port, token));
  const closeUi = isProduction ? mountBuiltUi(app) : await mountDevUi(app, httpServer);

  const detachSocket = attachTerminalSocket({
    pasteStore,
    httpServer,
    port,
    token,
    shell,
    registry,
    index,
    archived,
    notes,
    conversations,
    repos,
    memory,
    agents,
    defaultCwd,
  });

  // El indice arranca en segundo plano: 3,2 s en frio no pueden demorar la URL.
  /*
    Temporales de arranques anteriores.

    Un cierre sin gracia no pasa por el borrado de cada pestana, asi que la
    carpeta puede traer imagenes de la sesion pasada. Se limpia en segundo
    plano: nada del arranque depende de esto.
  */
  void pasteStore.purgeStale();

  void index.start();
  const stopWatching = watchSessions(index, conversations, agents);

  /*
    Las pestanas del arranque anterior tambien van en segundo plano: relanzar
    varias sesiones lleva su tiempo y la UI las va viendo aparecer.

    Se cargan aunque no haya ninguna CLI disponible: la restauracion es la que
    guarda aparte las pestanas que no puede mostrar, y sin ella el primer cambio
    —abrir una consola— reescribiria el archivo sin ninguna.
  */
  if (process.env['AGENT_WORKBENCH_NO_RESTORE'] !== '1') {
    void store.load().then((state) => {
      if (state.tabs.length === 0 && state.foreignTabs.length === 0) return;
      if (agents.anyAvailable()) {
        console.log(`Restaurando ${state.tabs.length} pestana(s) del arranque anterior...`);
      }
      return registry.restore(state);
    });
  }

  const url = `http://${LOOPBACK_HOST}:${port}/?${TOKEN_QUERY_PARAM}=${token}`;
  describeStartup(url, defaultCwd, agents, shell);
  // Escape para desarrollo y pruebas automatizadas: arrancar sin abrir nada.
  if (process.env['AGENT_WORKBENCH_NO_OPEN'] !== '1') openBrowser(url);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nCerrando Agent Workbench...');

    stopWatching();
    detachSocket();
    conversations.disposeAll();
    agents.disposeAll();
    repos.disposeAll();
    void memory.disposeAll();
    // Los procesos no sobreviven al cierre; las pestanas si, en disco.
    registry.disposeAll();

    void Promise.all([store.flush(), archived.flush(), notes.flush()])
      .catch(() => undefined)
      .then(() => closeUi())
      .catch(() => undefined)
      .finally(() => {
        httpServer.close(() => process.exit(0));
        // Si alguna conexion no cierra, no nos quedamos colgados.
        setTimeout(() => process.exit(0), 2_000).unref();
      });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  // Los errores de red y de spawn traen `code`/`errno` pero no `message`, y
  // salen como "{}" si se los imprime directo. Los desarmamos a mano.
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error, Object.getOwnPropertyNames(error))
        : String(error);
  console.error(`Agent Workbench no pudo arrancar:\n${detail}`);
  process.exit(1);
});
