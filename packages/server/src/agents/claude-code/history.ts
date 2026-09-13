/**
 * El historial de Claude Code: `~/.claude/projects/<slug>/<sessionId>.jsonl`.
 *
 * Solo lectura. Lo que esta fuente le da al indice es la enumeracion y el
 * resumen de cada archivo; agrupar en proyectos, cachear y emitir es del
 * indice generico.
 *
 * Sobre el slug: el nombre de la carpeta NO se puede revertir a una ruta
 * (CLAUDE.md 4.1). Aca solo viaja como `group`, el respaldo para agrupar una
 * sesion cuyo archivo no trae `cwd`.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { asStringArray } from '@agent-workbench/shared';
import type {
  HistoryExtra,
  HistoryItem,
  HistoryRoot,
  HistorySource,
  ScannedSession,
  SessionFollower,
} from '../adapter.js';
import type { ModelVariantRegistry } from './model-variants.js';
import { sessionFilePath, sessionsRoot } from './paths.js';
import { describePlans, readPlan } from './plans-store.js';
import { ClaudeCodeSessionFollower } from './session-follower.js';
import { scanSessionFile } from './session-scan.js';

const SESSION_EXTENSION = /\.jsonl$/i;

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function toItem(ref: string, info: { mtimeMs: number; size: number }): HistoryItem {
  return {
    ref,
    sessionId: path.basename(ref).replace(SESSION_EXTENSION, ''),
    group: path.basename(path.dirname(ref)),
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
  };
}

/**
 * Los ids de modelo que el escaneo aprendio de un archivo.
 *
 * Viajan en `extra` y vuelven de la cache del indice, que es JSON de disco: se
 * validan antes de creerles.
 */
function modelIdsOf(extra: HistoryExtra): string[] {
  return asStringArray(extra['modelIds']) ?? [];
}

/**
 * `variants` es el registro de la instalacion: el escaneo lo alimenta con los
 * ids de `cost-state` —la unica linea que trae el sufijo `[1m]`— y los
 * seguidores lo consultan para el medidor.
 */
export function createClaudeCodeHistory(variants: ModelVariantRegistry): HistorySource {
  return {
    roots(): readonly HistoryRoot[] {
      return [
        {
          path: sessionsRoot(),
          // Solo los .jsonl del primer nivel de cada proyecto.
          depth: 1,
          accepts: (filePath) => filePath.endsWith('.jsonl'),
          // La CLI escribe de a poco: se espera a que el archivo se estabilice.
          awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        },
      ];
    },

    async list(): Promise<HistoryItem[] | null> {
      const root = sessionsRoot();
      if (!(await pathExists(root))) return null;

      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

      const items: HistoryItem[] = [];
      for (const slug of directories) {
        let files: string[];
        try {
          files = (await readdir(path.join(root, slug))).filter((name) => name.endsWith('.jsonl'));
        } catch {
          // Carpeta ilegible: se salta sin romper el resto del historial.
          continue;
        }
        for (const file of files) {
          const ref = path.join(root, slug, file);
          try {
            items.push(toItem(ref, await stat(ref)));
          } catch {
            // Borrado entre el listado y el stat, o ilegible.
          }
        }
      }
      return items;
    },

    async changedRefs(filePath: string): Promise<readonly string[] | null> {
      const relative = path.relative(sessionsRoot(), filePath);
      const [slug] = relative.split(path.sep);
      if (slug === undefined || slug.length === 0 || slug.startsWith('..')) return null;
      if (!filePath.endsWith('.jsonl')) return null;
      // Un archivo por sesion: lo que cambio es exactamente esa sesion.
      return [filePath];
    },

    async item(ref: string): Promise<HistoryItem | null> {
      try {
        return toItem(ref, await stat(ref));
      } catch {
        return null;
      }
    },

    async scan(item: HistoryItem): Promise<ScannedSession> {
      const result = await scanSessionFile(item.ref, item.sessionId);
      for (const id of result.modelIds) variants.observe(id, item.mtimeMs);
      const { sessionId, title, titleSource, updatedAt, sizeBytes } = result.summary;
      return {
        cwd: result.cwd,
        summary: { sessionId, title, titleSource, updatedAt, sizeBytes },
        extra: { modelIds: result.modelIds },
      };
    },

    restored(item: HistoryItem, extra: HistoryExtra): void {
      // Tambien desde la cache: si no, un arranque en caliente se quedaria sin
      // saber que variante usa la instalacion.
      for (const id of modelIdsOf(extra)) variants.observe(id, item.mtimeMs);
    },

    /**
     * true si esa sesion ya tiene archivo en el historial.
     *
     * Decide entre `--resume` y `--session-id` al despertar una pestana:
     * reanudar una sesion que nunca escribio nada deja a la CLI mostrando un
     * error, y la pestana en pantalla queda sin explicacion.
     */
    async exists(cwd: string, sessionId: string): Promise<boolean> {
      return pathExists(sessionFilePath(cwd, sessionId));
    },

    follow(target: { cwd: string; sessionId: string }): SessionFollower {
      return new ClaudeCodeSessionFollower(target.cwd, target.sessionId, variants);
    },

    plans: { describe: describePlans, read: readPlan },

    // La CLI abre y cierra el archivo en cada linea: el watcher alcanza.
    followPollMs: null,
  };
}
