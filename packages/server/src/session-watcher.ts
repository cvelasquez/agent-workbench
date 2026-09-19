/**
 * Watcher sobre el historial de cada CLI registrada.
 *
 * Un chokidar por raiz declarada (`history.roots()` de cada adaptador), y cada
 * uno avisa a los dos consumidores. Levantar uno por consumidor seria duplicar
 * los handles del sistema de archivos sobre el mismo arbol de 33 MB para
 * enterarse de exactamente lo mismo.
 *
 * Lo que cambia entre consumidores es la espera, porque lo que esta en juego es
 * distinto:
 *
 *  - **El indice** reindexa lo que cambio. Un escaneo completo cuesta 3,2 s y
 *    la CLI escribe en cada turno: 750 ms de agrupado.
 *  - **La conversacion** solo lee lo nuevo desde un offset. Ahi los ms son
 *    latencia que el usuario ve mientras se escribe la respuesta, asi que la
 *    espera es corta y vive en el hub.
 *
 * chokidar y no `fs.watch`: el modo recursivo de `fs.watch` no existe en Linux,
 * y esta app tiene que correr en las tres plataformas.
 *
 * **Una raiz que todavia no existe no se le pasa a chokidar** (A3 del hito 25).
 * chokidar vigila una ruta inexistente mirando su carpeta padre, y el padre de
 * una raiz es la carpeta entera de la CLI —con Codex, `CODEX_HOME`, donde estan
 * sus credenciales—, que la app no lista nunca. Tampoco puede quedar sin
 * vigilar hasta reiniciar: es el primer uso de cualquiera, porque la carpeta de
 * sesiones nace con la primera sesion, y la pestana que la escribe se quedaria
 * sin ver su respuesta. Asi que se mira con `stat` **esa ruta exacta** cada
 * tanto, y cuando aparece se empieza a vigilar avisando de lo que ya trae.
 *
 * **Una raiz con `watch` no pasa por nada de esto** (hito 26): ni chokidar ni
 * sondeo. Es la de una base compartida que otro proceso tiene abierta, donde un
 * watcher de archivos no sirve; la fuente avisa con su propio sondeo, y el aviso
 * sigue el mismo camino que uno de chokidar.
 */

import { stat } from 'node:fs/promises';
import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import type { AgentId } from '@agent-workbench/shared';
import type { HistoryRoot } from './agents/adapter.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ConversationHub } from './conversation-hub.js';
import type { SessionIndex } from './session-index.js';

/** Agrupado para el reindexado. La CLI escribe muchas veces por respuesta. */
const INDEX_DEBOUNCE_MS = 750;

/**
 * Cada cuanto se mira si aparecio una raiz que no existia. Una raiz nace una
 * vez en la vida de una instalacion, y un `stat` cada cinco segundos no le
 * cuesta nada a nadie.
 */
const ROOT_PROBE_MS = 5_000;

export interface WatchSessionsOptions {
  /** Para el chequeo. */
  rootProbeMs?: number;
  /** Para el chequeo: con que se crea cada watcher. */
  watch?: (path: string, options: ChokidarOptions) => FSWatcher;
}

/** Lo que el watcher usa de cada consumidor. */
type IndexSink = Pick<SessionIndex, 'refreshPath'>;
type HubSink = Pick<ConversationHub, 'onHistoryChanged'>;
type AgentSource = Pick<AgentRegistry, 'all'>;

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export function watchSessions(
  index: IndexSink,
  hub: HubSink,
  agents: AgentSource,
  options: WatchSessionsOptions = {},
): () => void {
  const probeMs = options.rootProbeMs ?? ROOT_PROBE_MS;
  const createWatcher = options.watch ?? ((target, watchOptions) => chokidar.watch(target, watchOptions));
  const pending = new Map<string, NodeJS.Timeout>();
  const watchers: FSWatcher[] = [];
  const probes = new Set<NodeJS.Timeout>();
  let stopped = false;

  const stops: (() => void)[] = [];

  /** Lo mismo para un aviso de chokidar que para uno de `root.watch`. */
  const onFileEvent = (agent: AgentId, root: HistoryRoot, filePath: string): void => {
    // Un aviso que llega mientras se cierra no programa nada que nadie va a cancelar.
    if (stopped || !root.accepts(filePath)) return;

    // El hub se entera enseguida; el debounce corto lo maneja el.
    hub.onHistoryChanged(agent, filePath);

    const key = `${agent}:${filePath}`;
    const existing = pending.get(key);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      pending.delete(key);
      void index.refreshPath(agent, filePath);
    }, INDEX_DEBOUNCE_MS);
    timer.unref();
    pending.set(key, timer);
  };

  /**
   * Una raiz que trae su propio aviso (D5 del hito 26). Ni chokidar ni sondeo de
   * la raiz: la fuente sabe mejor que un watcher de archivos cuando cambio, y
   * tambien cuando nace lo que vigila.
   */
  const subscribeRoot = (agent: AgentId, root: HistoryRoot, watch: NonNullable<HistoryRoot['watch']>): void => {
    try {
      stops.push(watch((filePath) => onFileEvent(agent, root, filePath)));
    } catch (error) {
      console.warn("[watcher] couldn't watch the history:", error);
    }
  };

  /**
   * `announceExisting` es para una raiz que aparecio con el servidor andando:
   * lo que ya trae se avisa como si acabara de llegar, porque llego despues del
   * escaneo del indice y la pestana que lo escribio esta esperando.
   */
  const watchRoot = (agent: AgentId, root: HistoryRoot, announceExisting: boolean): void => {
    const onRootEvent = (filePath: string): void => onFileEvent(agent, root, filePath);

    let watcher: FSWatcher;
    try {
      watcher = createWatcher(root.path, {
        depth: root.depth,
        ignoreInitial: !announceExisting,
        awaitWriteFinish: root.awaitWriteFinish,
        // Solo si la raiz lo declara: las que no, se recorren igual que antes.
        ...(root.ignore !== undefined ? { ignored: root.ignore } : {}),
      });
    } catch (error) {
      // Una raiz que no se puede observar no le quita el aviso a las demas.
      console.warn("[watcher] couldn't watch the history:", error);
      return;
    }

    watcher.on('add', onRootEvent);
    watcher.on('change', onRootEvent);
    watcher.on('unlink', onRootEvent);
    watcher.on('error', (error) => console.warn('[watcher] error:', error));
    watchers.push(watcher);
  };

  /** Mira la raiz exacta hasta que exista. Nunca su padre. */
  const probeRoot = (agent: AgentId, root: HistoryRoot): void => {
    let checking = false;
    const probe = setInterval(() => {
      if (checking) return;
      checking = true;
      void isDirectory(root.path).then((exists) => {
        checking = false;
        if (!exists || stopped || !probes.has(probe)) return;
        clearInterval(probe);
        probes.delete(probe);
        watchRoot(agent, root, true);
      });
    }, probeMs);
    probe.unref();
    probes.add(probe);
  };

  for (const { adapter } of agents.all()) {
    for (const root of adapter.history.roots()) {
      if (root.watch !== undefined) {
        subscribeRoot(adapter.id, root, root.watch);
        continue;
      }
      void isDirectory(root.path).then((exists) => {
        if (stopped) return;
        if (exists) watchRoot(adapter.id, root, false);
        else probeRoot(adapter.id, root);
      });
    }
  }

  return () => {
    stopped = true;
    for (const probe of probes) clearInterval(probe);
    probes.clear();
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const watcher of watchers) void watcher.close();
    for (const stop of stops.splice(0)) {
      try {
        stop();
      } catch (error) {
        console.warn("[watcher] couldn't stop watching the history:", error);
      }
    }
  };
}
