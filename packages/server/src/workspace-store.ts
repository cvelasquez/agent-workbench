/**
 * Persistencia de las pestanas abiertas.
 *
 * Dos decisiones que corrigen al brief:
 *
 *  - Se guarda **en cada cambio**, no "al cerrar la app". En un navegador no
 *    hay evento de cierre confiable: `beforeunload` no siempre corre y un
 *    cierre forzado nunca lo dispara.
 *  - Se guarda en el directorio de configuracion propio, **nunca** dentro de
 *    `~/.claude/`. Esa carpeta es de la CLI y solo la leemos.
 *
 * Los procesos no sobreviven al cierre: lo que se restaura es la lista de
 * pestanas, que se vuelven a abrir con `--resume`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appConfigDir, workspaceStatePath } from './paths.js';

const STATE_VERSION = 1;
/** Espera antes de escribir, para no tocar el disco en cada tecla de un rename. */
const WRITE_DEBOUNCE_MS = 400;

/** Una pestana tal como se guarda entre arranques. */
export interface PersistedTab {
  cwd: string;
  sessionId: string;
  label: string;
}

export interface WorkspaceState {
  tabs: PersistedTab[];
}

function parseState(raw: string): WorkspaceState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== STATE_VERSION) return null;

    const rawTabs = record['tabs'];
    if (!Array.isArray(rawTabs)) return null;

    const tabs: PersistedTab[] = [];
    for (const entry of rawTabs) {
      if (typeof entry !== 'object' || entry === null) continue;
      const tab = entry as Record<string, unknown>;
      const cwd = tab['cwd'];
      const sessionId = tab['sessionId'];
      const label = tab['label'];
      if (typeof cwd !== 'string' || typeof sessionId !== 'string') continue;
      tabs.push({ cwd, sessionId, label: typeof label === 'string' ? label : '' });
    }
    return { tabs };
  } catch {
    return null;
  }
}

export class WorkspaceStore {
  private writeTimer: NodeJS.Timeout | null = null;
  private pending: WorkspaceState | null = null;

  async load(): Promise<WorkspaceState> {
    try {
      const raw = await readFile(workspaceStatePath(), 'utf8');
      return parseState(raw) ?? { tabs: [] };
    } catch {
      // Primer arranque, o archivo corrupto. Se empieza limpio.
      return { tabs: [] };
    }
  }

  /** Encola una escritura. Llamar en cada cambio sin miedo. */
  save(state: WorkspaceState): void {
    this.pending = state;
    if (this.writeTimer !== null) return;

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const toWrite = this.pending;
      this.pending = null;
      if (toWrite !== null) void this.writeNow(toWrite);
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  /** Escritura inmediata, para el apagado. */
  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    const toWrite = this.pending;
    this.pending = null;
    if (toWrite !== null) await this.writeNow(toWrite);
  }

  private async writeNow(state: WorkspaceState): Promise<void> {
    try {
      await mkdir(appConfigDir(), { recursive: true });
      const target = workspaceStatePath();
      // Escritura atomica: un corte de luz a mitad no deja el archivo a medias.
      const temporary = path.join(path.dirname(target), `workspace.${process.pid}.tmp`);
      await writeFile(
        temporary,
        JSON.stringify({ version: STATE_VERSION, tabs: state.tabs }, null, 2),
        'utf8',
      );
      const { rename } = await import('node:fs/promises');
      await rename(temporary, target);
    } catch (error) {
      console.warn('[workspace] no se pudo guardar el estado:', error);
    }
  }
}
