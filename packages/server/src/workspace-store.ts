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
 *
 * **La version sigue en 1 aunque cada pestana ahora diga su CLI**, y es a
 * proposito. El parser de la version 1 lee `cwd`, `sessionId` y `label` e
 * ignora lo demas, asi que un `agent` de mas no le molesta a una build
 * anterior; subir la version, en cambio, haria que esa build no lo leyera, que
 * arrancara sin pestanas y que el primer cambio reescribiera el archivo vacio.
 * Pasa con cualquier build que comparta el directorio de configuracion: la rama
 * principal o el paquete de npm ya publicado.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_IDS, asLiteral, type AgentId, type TerminalDescriptor } from '@agent-workbench/shared';
import { appConfigDir, workspaceStatePath } from './paths.js';

const STATE_VERSION = 1;
/** Espera antes de escribir, para no tocar el disco en cada tecla de un rename. */
const WRITE_DEBOUNCE_MS = 400;

/**
 * La CLI de una pestana guardada sin el campo: la unica que habia cuando se
 * escribio.
 */
const LEGACY_TAB_AGENT: AgentId = 'claude-code';

/** Una pestana tal como se guarda entre arranques. */
export interface PersistedTab {
  agent: AgentId;
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
      /*
        Sin `agent` es de antes de que hubiera mas de una CLI. Con un `agent` que
        esta build no conoce —lo escribio una mas nueva— la pestana se salta y
        las demas siguen: reanudarla con otra CLI no encontraria la sesion.
      */
      let agent: AgentId = LEGACY_TAB_AGENT;
      if (tab['agent'] !== undefined) {
        const known = asLiteral(tab['agent'], AGENT_IDS);
        if (known === null) {
          console.warn(
            `[workspace] no se restaura la pestana de ${cwd}: CLI desconocida ${JSON.stringify(tab['agent'])}`,
          );
          continue;
        }
        agent = known;
      }
      tabs.push({ agent, cwd, sessionId, label: typeof label === 'string' ? label : '' });
    }
    return { tabs };
  } catch {
    return null;
  }
}

/**
 * Que pestanas se guardan: las de una CLI, y **solo** esas.
 *
 * Una consola no se restaura: no tiene conversacion que reanudar, y volver a
 * abrirla al arrancar seria dejar un proceso corriendo que el usuario no pidio.
 * Reabrirla cuesta un clic. Tampoco una pestana cuyo id de sesion todavia no se
 * conoce: no habria que reanudar. Con Claude Code el id se fija al lanzar y
 * nunca esta vacio.
 */
export function persistableTabs(descriptors: readonly TerminalDescriptor[]): PersistedTab[] {
  const tabs: PersistedTab[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'agent' || descriptor.agent === null) continue;
    if (descriptor.sessionId.length === 0) continue;
    tabs.push({
      agent: descriptor.agent,
      cwd: descriptor.cwd,
      sessionId: descriptor.sessionId,
      label: descriptor.label,
    });
  }
  return tabs;
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
