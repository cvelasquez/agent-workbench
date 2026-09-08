/**
 * Watcher sobre `~/.claude/projects/`.
 *
 * Un solo chokidar para los dos consumidores. Levantar uno por cada uno seria
 * duplicar los handles del sistema de archivos sobre el mismo arbol de 33 MB
 * para enterarse de exactamente lo mismo.
 *
 * Lo que cambia entre consumidores es la espera, porque lo que esta en juego es
 * distinto:
 *
 *  - **El indice** reindexa el archivo que cambio. Un escaneo completo cuesta
 *    3,2 s y la CLI escribe en cada turno: 750 ms de agrupado.
 *  - **La conversacion** solo lee lo nuevo desde un offset. Ahi los ms son
 *    latencia que el usuario ve mientras se escribe la respuesta, asi que la
 *    espera es corta y vive en el hub.
 *
 * chokidar y no `fs.watch`: el modo recursivo de `fs.watch` no existe en Linux,
 * y esta app tiene que correr en las tres plataformas.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import type { ConversationHub } from './conversation-hub.js';
import type { SessionIndex } from './session-index.js';
import { sessionsRoot } from './paths.js';

/** Agrupado para el reindexado. La CLI escribe muchas veces por respuesta. */
const INDEX_DEBOUNCE_MS = 750;

export function watchSessions(index: SessionIndex, hub: ConversationHub): () => void {
  const root = sessionsRoot();
  const pending = new Map<string, NodeJS.Timeout>();

  const onFileEvent = (filePath: string): void => {
    if (!filePath.endsWith('.jsonl')) return;

    // El hub se entera enseguida; el debounce corto lo maneja el.
    hub.onFileChanged(filePath);

    const existing = pending.get(filePath);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      pending.delete(filePath);
      void index.refreshFile(filePath);
    }, INDEX_DEBOUNCE_MS);
    timer.unref();
    pending.set(filePath, timer);
  };

  let watcher: FSWatcher;
  try {
    watcher = chokidar.watch(root, {
      // Solo los .jsonl del primer nivel de cada proyecto.
      depth: 1,
      ignoreInitial: true,
      // La CLI escribe de a poco: esperamos a que el archivo se estabilice.
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
  } catch (error) {
    console.warn('[watcher] no se pudo observar el historial:', error);
    return () => undefined;
  }

  watcher.on('add', onFileEvent);
  watcher.on('change', onFileEvent);
  watcher.on('unlink', onFileEvent);
  watcher.on('error', (error) => console.warn('[watcher] error:', error));

  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    void watcher.close();
  };
}
