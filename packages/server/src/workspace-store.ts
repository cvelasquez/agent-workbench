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
 *
 * **Y por lo mismo `tabs` guarda solo pestanas de Claude Code** (hito 25, M1).
 * Ese parser anterior no mira `agent`: una pestana de otra CLI en `tabs` la
 * restauraria como de Claude Code, y al despertarla lanzaria `claude` con el id
 * de una sesion ajena. Las demas van en `otherTabs`, que ninguna build anterior
 * lee, con su `position` en la lista completa para volver a su lugar. Una build
 * anterior las pierde al guardar, pero nunca las usa mal.
 *
 * Tampoco se pierden las que esta build no puede mostrar: las de una CLI que no
 * conoce (las escribio una mas nueva) se guardan crudas, y el registro conserva
 * las de una CLI conocida que no esta instalada (`mergePersistedTabs`). Se
 * pierden solo si el usuario borra el archivo.
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
 * escribio. Es tambien la unica que va en `tabs`.
 */
const LEGACY_TAB_AGENT: AgentId = 'claude-code';

/** Una pestana tal como se guarda entre arranques. */
export interface PersistedTab {
  agent: AgentId;
  cwd: string;
  sessionId: string;
  label: string;
}

/** Una pestana de una CLI conocida que no esta en pantalla, con su lugar en la lista completa. */
export interface PlacedTab {
  position: number;
  tab: PersistedTab;
}

/**
 * Una pestana de una CLI que esta build no conoce, tal como estaba en el
 * archivo (sin `position`), con su lugar en la lista completa.
 */
export interface ForeignTab {
  position: number;
  raw: Record<string, unknown>;
}

export interface WorkspaceState {
  /** Pestanas de CLIs que esta build conoce, en el orden de la barra. */
  tabs: PersistedTab[];
  /** Las de CLIs que no conoce. Van y vuelven sin tocarse. */
  foreignTabs: ForeignTab[];
}

/** Una entrada de la lista completa: la que se restaura o la que se conserva cruda. */
export type OrderedTab = { kind: 'known'; tab: PersistedTab } | { kind: 'foreign'; raw: Record<string, unknown> };

/**
 * Inserta en `base` cada elemento de `placed` en su `position`, de la menor a
 * la mayor. Dos con la misma posicion conservan su orden, y una posicion mas
 * alla del final va al final. Si las posiciones salieron de los indices de una
 * lista completa, devuelve esa misma lista.
 */
function placeByPosition<T>(base: readonly T[], placed: readonly { position: number; item: T }[]): T[] {
  const result = [...base];
  const sorted = placed
    .map((entry, order) => ({ ...entry, order }))
    .sort((a, b) => a.position - b.position || a.order - b.order);
  let last = -1;
  for (const { position, item } of sorted) {
    const index = Math.min(Math.max(position, last + 1), result.length);
    result.splice(index, 0, item);
    last = index;
  }
  return result;
}

/** La lista completa en orden, con las ajenas en su lugar. */
export function orderedTabs(state: WorkspaceState): OrderedTab[] {
  return placeByPosition<OrderedTab>(
    state.tabs.map((tab) => ({ kind: 'known', tab })),
    state.foreignTabs.map(({ position, raw }) => ({ position, item: { kind: 'foreign', raw } })),
  );
}

/** Lo inverso de `orderedTabs`: cada ajena se queda con su indice como posicion. */
function splitOrdered(entries: readonly OrderedTab[]): WorkspaceState {
  const tabs: PersistedTab[] = [];
  const foreignTabs: ForeignTab[] = [];
  for (const [position, entry] of entries.entries()) {
    if (entry.kind === 'known') tabs.push(entry.tab);
    else foreignTabs.push({ position, raw: entry.raw });
  }
  return { tabs, foreignTabs };
}

/**
 * Lo que se guarda: las pestanas vivas, y las que no se muestran de vuelta en
 * su lugar. Pura: lo prueba el chequeo.
 *
 * Una no disponible que ya tiene pestana viva —misma CLI y misma sesion— no se
 * repite: la viva manda.
 */
export function mergePersistedTabs(
  live: readonly PersistedTab[],
  unavailable: readonly PlacedTab[],
  foreign: readonly ForeignTab[],
): WorkspaceState {
  const kept = unavailable.filter(
    ({ tab }) => !live.some((other) => other.agent === tab.agent && other.sessionId === tab.sessionId),
  );
  return splitOrdered(
    placeByPosition<OrderedTab>(live.map((tab) => ({ kind: 'known', tab })), [
      ...kept.map(({ position, tab }) => ({ position, item: { kind: 'known', tab } as OrderedTab })),
      ...foreign.map(({ position, raw }) => ({ position, item: { kind: 'foreign', raw } as OrderedTab })),
    ]),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Una entrada de `tabs` o de `otherTabs`. null si no se puede usar ni
 * conservar: sin `cwd` o `sessionId` de texto no hay pestana.
 */
function readTab(tab: Record<string, unknown>, missingAgent: AgentId | null): OrderedTab | null {
  const { cwd, sessionId, label } = tab;
  if (typeof cwd !== 'string' || typeof sessionId !== 'string') return null;

  let agent: AgentId | null = missingAgent;
  if (tab['agent'] !== undefined) {
    agent = asLiteral(tab['agent'], AGENT_IDS);
    if (agent === null) {
      /*
        La escribio una build mas nueva. Reanudarla con otra CLI no encontraria
        la sesion, asi que no se restaura; pero se guarda cruda, para que esa
        build la encuentre al volver.
      */
      console.warn(
        `[workspace] no se restaura la pestana de ${cwd}: CLI desconocida ${JSON.stringify(tab['agent'])}. Se conserva en el archivo.`,
      );
      return { kind: 'foreign', raw: tab };
    }
  }
  if (agent === null) return null;
  return { kind: 'known', tab: { agent, cwd, sessionId, label: typeof label === 'string' ? label : '' } };
}

function parseState(raw: string): WorkspaceState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed['version'] !== STATE_VERSION) return null;

    const rawTabs = parsed['tabs'];
    if (!Array.isArray(rawTabs)) return null;

    // Sin `agent` en `tabs` es de antes de que hubiera mas de una CLI.
    const base: OrderedTab[] = [];
    for (const entry of rawTabs) {
      if (!isRecord(entry)) continue;
      const tab = readTab(entry, LEGACY_TAB_AGENT);
      if (tab !== null) base.push(tab);
    }

    // En `otherTabs` una entrada sin `agent` no dice de que CLI es: se descarta.
    const placed: { position: number; item: OrderedTab }[] = [];
    const rawOthers = parsed['otherTabs'];
    for (const entry of Array.isArray(rawOthers) ? rawOthers : []) {
      if (!isRecord(entry)) continue;
      const { position, ...rest } = entry;
      const tab = readTab(rest, null);
      if (tab === null) continue;
      placed.push({
        position: Number.isSafeInteger(position) && (position as number) >= 0 ? (position as number) : Number.MAX_SAFE_INTEGER,
        item: tab,
      });
    }

    return splitOrdered(placeByPosition(base, placed));
  } catch {
    return null;
  }
}

/**
 * Lo que va al archivo. `tabs` solo con pestanas de Claude Code y en su orden;
 * el resto en `otherTabs`, con su posicion. Sin otras, el archivo es el mismo
 * de antes del hito 25, byte por byte.
 */
export function serializeState(state: WorkspaceState): Record<string, unknown> {
  const tabs: PersistedTab[] = [];
  const otherTabs: Record<string, unknown>[] = [];
  for (const [position, entry] of orderedTabs(state).entries()) {
    if (entry.kind === 'foreign') {
      otherTabs.push({ ...entry.raw, position });
    } else if (entry.tab.agent === LEGACY_TAB_AGENT) {
      tabs.push(entry.tab);
    } else {
      otherTabs.push({ ...entry.tab, position });
    }
  }
  return otherTabs.length === 0
    ? { version: STATE_VERSION, tabs }
    : { version: STATE_VERSION, tabs, otherTabs };
}

const EMPTY_STATE = (): WorkspaceState => ({ tabs: [], foreignTabs: [] });

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
      return parseState(raw) ?? EMPTY_STATE();
    } catch {
      // Primer arranque, o archivo corrupto. Se empieza limpio.
      return EMPTY_STATE();
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
      await writeFile(temporary, JSON.stringify(serializeState(state), null, 2), 'utf8');
      const { rename } = await import('node:fs/promises');
      await rename(temporary, target);
    } catch (error) {
      console.warn('[workspace] no se pudo guardar el estado:', error);
    }
  }
}
