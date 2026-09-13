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
 */

import chokidar, { type FSWatcher } from 'chokidar';
import type { AgentId } from '@agent-workbench/shared';
import type { HistoryRoot } from './agents/adapter.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ConversationHub } from './conversation-hub.js';
import type { SessionIndex } from './session-index.js';

/** Agrupado para el reindexado. La CLI escribe muchas veces por respuesta. */
const INDEX_DEBOUNCE_MS = 750;

export function watchSessions(
  index: SessionIndex,
  hub: ConversationHub,
  agents: AgentRegistry,
): () => void {
  const pending = new Map<string, NodeJS.Timeout>();
  const watchers: FSWatcher[] = [];

  const watchRoot = (agent: AgentId, root: HistoryRoot): void => {
    const onFileEvent = (filePath: string): void => {
      if (!root.accepts(filePath)) return;

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

    let watcher: FSWatcher;
    try {
      watcher = chokidar.watch(root.path, {
        depth: root.depth,
        ignoreInitial: true,
        awaitWriteFinish: root.awaitWriteFinish,
      });
    } catch (error) {
      // Una raiz que no se puede observar no le quita el aviso a las demas.
      console.warn('[watcher] no se pudo observar el historial:', error);
      return;
    }

    watcher.on('add', onFileEvent);
    watcher.on('change', onFileEvent);
    watcher.on('unlink', onFileEvent);
    watcher.on('error', (error) => console.warn('[watcher] error:', error));
    watchers.push(watcher);
  };

  for (const { adapter } of agents.all()) {
    for (const root of adapter.history.roots()) watchRoot(adapter.id, root);
  }

  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const watcher of watchers) void watcher.close();
  };
}
