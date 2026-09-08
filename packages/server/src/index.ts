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
import { TOKEN_QUERY_PARAM } from '@agent-workbench/shared';
import { ArchivedSessions } from './archived-sessions.js';
import { cliNotFoundMessage, locateCli, type CliLocation } from './cli-locator.js';
import { CliStatusWatcher } from './cli-status.js';
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
import { inheritedChildSessionMarker } from './pty-session.js';
import { RepoHub } from './repo-hub.js';
import { PasteStore } from './paste-store.js';
import { SessionIndex } from './session-index.js';
import { ModelVariantRegistry } from './model-variants.js';
import { NotesStore } from './notes-store.js';
import { locateShell, type ShellLocation } from './shell-locator.js';
import { watchSessions } from './session-watcher.js';
import { TerminalRegistry } from './terminal-registry.js';
import { attachTerminalSocket } from './terminal-socket.js';
import { WorkspaceStore } from './workspace-store.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(serverDir, '../../web');
const webDist = path.join(webRoot, 'dist');
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
const isProduction = process.argv.includes('--prod');

/** Sugerencia de directorio para la primera pestana. */
function resolveDefaultCwd(): string {
  const override = process.env['AGENT_WORKBENCH_CWD'];
  if (override !== undefined && override.length > 0) return path.resolve(override);
  // pnpm ejecuta el script dentro de packages/server, asi que process.cwd() no
  // sirve como valor por defecto.
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

function describeStartup(
  url: string,
  cwd: string,
  cli: CliLocation | null,
  shell: ShellLocation | null,
): void {
  const line = '-'.repeat(64);
  console.log(`\n${line}`);
  console.log('  Agent Workbench');
  console.log(line);
  console.log(`  URL          ${url}`);
  console.log(`  Modo         ${isProduction ? 'produccion (interfaz compilada)' : 'desarrollo'}`);
  console.log(`  Directorio   ${cwd}`);
  if (cli === null) {
    console.log('  CLI          NO ENCONTRADA');
    console.log(`\n  ${cliNotFoundMessage()}`);
  } else {
    console.log(`  CLI          ${cli.version ?? 'version desconocida'}`);
    console.log(`  Binario      ${cli.resolvedPath}`);
  }
  console.log(`  Consola      ${shell === null ? 'no encontrada' : shell.file}`);
  if (inheritedChildSessionMarker) {
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
  // Buscar la CLI no bloquea el arranque: si falta, la UI lo explica. La
  // consola del panel derecho se busca a la vez y es opcional: sin ella el
  // resto de la app funciona igual.
  const [cli, shell] = await Promise.all([locateCli(), locateShell()]);

  // Antes de que nadie lea la configuracion: si quedo en el directorio del
  // nombre viejo, se mueve al nuevo (ver `config-dir-migration.ts`).
  const movedFrom = await migrateLegacyConfigDir();
  if (movedFrom !== null) console.log(`Configuracion movida de ${movedFrom} a ${appConfigDir()}`);

  const store = new WorkspaceStore();
  /*
    Estado en vivo de cada proceso de la CLI, leido de `~/.claude/sessions/`.
    Uno solo para toda la app: lo miran el registro —para contestar el dialogo
    de reanudar— y el hub de conversaciones —para avisar que la CLI espera algo.
  */
  const cliStatus = new CliStatusWatcher();
  const registry = new TerminalRegistry(cli, shell, store, cliStatus);
  /*
    Que variante de modelo usa esta instalacion. Lo llena el indice mientras lee
    la cola de los archivos del historial —donde vive `cost-state`, la unica
    linea que trae el sufijo `[1m]`— y lo consulta el medidor de contexto.
  */
  const modelVariants = new ModelVariantRegistry();
  // Que sesiones escondio el usuario de la barra lateral. Se carga antes del
  // indice: si no, el primer envio las mostraria todas y desapareceria solas.
  const archived = new ArchivedSessions();
  await archived.load();
  const index = new SessionIndex(modelVariants, archived);
  // Notas sueltas del usuario. Se cargan antes de aceptar conexiones: el
  // primer mensaje de cada socket ya lleva la lista.
  const notes = new NotesStore();
  await notes.load();
  const conversations = new ConversationHub(registry, cliStatus, modelVariants);
  const repos = new RepoHub(registry);
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
    cli,
    shell,
    registry,
    index,
    archived,
    notes,
    conversations,
    repos,
    cliStatus,
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
  const stopWatching = watchSessions(index, conversations);

  // Las pestanas del arranque anterior tambien van en segundo plano: relanzar
  // varias sesiones lleva su tiempo y la UI las va viendo aparecer.
  if (cli !== null && process.env['AGENT_WORKBENCH_NO_RESTORE'] !== '1') {
    void store.load().then((state) => {
      if (state.tabs.length === 0) return;
      console.log(`Restaurando ${state.tabs.length} pestana(s) del arranque anterior...`);
      return registry.restore(state.tabs);
    });
  }

  const url = `http://${LOOPBACK_HOST}:${port}/?${TOKEN_QUERY_PARAM}=${token}`;
  describeStartup(url, defaultCwd, cli, shell);
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
    cliStatus.dispose();
    repos.disposeAll();
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
