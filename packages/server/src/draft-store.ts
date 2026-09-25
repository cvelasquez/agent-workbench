/**
 * Los borradores del cuadro de escritura, entre arranques (mejoras de la 0.4.0,
 * §6.29).
 *
 * Lo escrito y sin mandar en el cuadro de una pestana llega aca despues de una
 * pausa del teclado, y vuelve a la pestana al abrir la app al dia siguiente.
 * Vive en el directorio de configuracion propio, como las notas, nunca en la
 * carpeta de una CLI.
 *
 * **La clave es la conversacion, `(agent, sessionId)`, no la pestana.** El
 * `terminalId` se inventa de nuevo en cada arranque (`restore`), y el id de la
 * conversacion es lo que `workspace.json` guarda de cada pestana. Una pestana
 * cuya conversacion todavia no tiene id —una CLI que lo descubre despues de
 * lanzar— tampoco se restaura, asi que no hay donde guardarle nada.
 *
 * Tres cosas que no son evidentes:
 *
 *  - **Guardar relee el archivo y cambia solo lo que cambio aca.** Dos
 *    instancias de la app comparten la carpeta (§14.8): reescribirlo entero con
 *    lo de la memoria borraria los borradores de la otra.
 *  - **Un borrador vacio borra el guardado**, y el que pasa del tope tambien: si
 *    no se puede guardar entero, uno viejo que vuelve al dia siguiente como si
 *    fuera todo es peor que ninguno. El cuadro lo avisa.
 *  - **Una version desconocida del archivo se lee como vacia** y se reescribe
 *    con el primer cambio, como las notas: un borrador es de corta vida.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_COMPOSER_DRAFT_CHARS,
  asArrayFiltered,
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  composerDraftChars,
  isEmptyComposerDraft,
  parseComposerDraft,
  sameComposerDraft,
  type ComposerDraft,
  type TerminalDescriptor,
} from '@agent-workbench/shared';
import { composerDraftsPath } from './paths.js';
import type { WorkspaceState } from './workspace-store.js';

const STATE_VERSION = 1;
/** El borrador llega con cada pausa del teclado; a disco va cuando hay otra pausa. */
const WRITE_DEBOUNCE_MS = 500;

/**
 * Cuantos borradores se guardan, como mucho: mas que las pestanas que caben
 * abiertas (24), con holgura para las de una CLI que hoy no esta instalada y
 * cuya pestana se conserva. Pasado el tope se va el mas viejo.
 */
export const MAX_STORED_DRAFTS = 100;

/** La conversacion de la que es un borrador. */
export interface DraftOwner {
  agent: string;
  sessionId: string;
}

interface StoredDraft extends DraftOwner {
  draft: ComposerDraft;
  updatedAt: number;
}

/** Que paso con un borrador que llego. */
export type DraftSaveOutcome = 'saved' | 'deleted' | 'unchanged' | 'too-long';

/**
 * La conversacion de una pestana, o null: una consola, que no tiene cuadro, o
 * una pestana cuya CLI todavia no dijo su id. Esa tampoco se guarda en
 * `workspace.json` (`persistableTabs`): no volveria, y su borrador tampoco.
 */
export function draftOwnerOf(descriptor: TerminalDescriptor | null): DraftOwner | null {
  if (descriptor === null || descriptor.kind !== 'agent' || descriptor.agent === null) return null;
  if (descriptor.sessionId.length === 0) return null;
  return { agent: descriptor.agent, sessionId: descriptor.sessionId };
}

/**
 * Las conversaciones de las pestanas del archivo del arranque, tambien las que
 * no se muestran: las de una CLI que no esta instalada y las que escribio una
 * build mas nueva, que vuelven al archivo tal cual (§3.2).
 */
export function workspaceDraftOwners(state: WorkspaceState): DraftOwner[] {
  const owners: DraftOwner[] = state.tabs.map(({ agent, sessionId }) => ({ agent, sessionId }));
  for (const { raw } of state.foreignTabs) {
    const agent = raw['agent'];
    const sessionId = raw['sessionId'];
    if (typeof agent === 'string' && typeof sessionId === 'string') owners.push({ agent, sessionId });
  }
  return owners;
}

/**
 * Sigue las pestanas de un cambio al siguiente, para dos cosas: el borrador de
 * una pestana que aparece —la restauracion del arranque llega despues de que la
 * pagina se conecto— se anuncia, y el de una pestana que cambia de
 * conversacion se muda con ella.
 *
 * Una pestana que se queda sin id —relanzada sobre una sesion que ya no esta,
 * con una CLI que lo descubre despues— conserva su conversacion anterior hasta
 * que aparezca la nueva: en el medio no hay a donde mudar nada.
 */
export class DraftTabs {
  private seen = new Set<string>();
  private readonly owners = new Map<string, DraftOwner>();

  update(descriptors: readonly TerminalDescriptor[]): {
    appeared: TerminalDescriptor[];
    moved: { from: DraftOwner; to: DraftOwner }[];
  } {
    const appeared: TerminalDescriptor[] = [];
    const moved: { from: DraftOwner; to: DraftOwner }[] = [];
    const present = new Set<string>();
    for (const descriptor of descriptors) {
      const { terminalId } = descriptor;
      present.add(terminalId);
      if (!this.seen.has(terminalId)) appeared.push(descriptor);
      const current = draftOwnerOf(descriptor);
      if (current === null) continue;
      const previous = this.owners.get(terminalId);
      if (previous !== undefined && keyOf(previous) !== keyOf(current)) moved.push({ from: previous, to: current });
      this.owners.set(terminalId, current);
    }
    for (const terminalId of [...this.owners.keys()]) {
      if (!present.has(terminalId)) this.owners.delete(terminalId);
    }
    this.seen = present;
    return { appeared, moved };
  }
}

/** Una clave sin ambiguedad: ni un id ni una CLI pueden fabricar la de otra. */
function keyOf(owner: DraftOwner): string {
  return JSON.stringify([owner.agent, owner.sessionId]);
}

function copyOf(draft: ComposerDraft): ComposerDraft {
  return { text: draft.text, pasted: draft.pasted.map((paste) => ({ ...paste })) };
}

function parseEntry(value: unknown): StoredDraft | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asNonEmptyString(record['agent']);
  const sessionId = asNonEmptyString(record['sessionId']);
  const draft = parseComposerDraft(record['draft']);
  const updatedAt = asFiniteNumber(record['updatedAt']);
  if (agent === null || sessionId === null || draft === null || updatedAt === null) return null;
  // Lo que no se hubiera guardado tampoco se lee.
  if (isEmptyComposerDraft(draft) || composerDraftChars(draft) > MAX_COMPOSER_DRAFT_CHARS) return null;
  return { agent, sessionId, draft, updatedAt };
}

/** Los borradores del archivo, por clave. Ilegible o de otra version, ninguno. */
function parseState(raw: string): Map<string, StoredDraft> {
  const drafts = new Map<string, StoredDraft>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return drafts;
  }
  const record = asRecord(parsed);
  if (record === null || record['version'] !== STATE_VERSION) return drafts;
  // Uno mal formado se descarta solo: no se lleva los de las demas pestanas.
  for (const entry of asArrayFiltered(record['drafts'], parseEntry) ?? []) drafts.set(keyOf(entry), entry);
  return drafts;
}

/** Deja los `MAX_STORED_DRAFTS` mas nuevos. Devuelve las claves que se fueron. */
function trimOldest(drafts: Map<string, StoredDraft>): string[] {
  if (drafts.size <= MAX_STORED_DRAFTS) return [];
  const oldest = [...drafts.entries()]
    .sort(([, a], [, b]) => a.updatedAt - b.updatedAt)
    .slice(0, drafts.size - MAX_STORED_DRAFTS)
    .map(([key]) => key);
  for (const key of oldest) drafts.delete(key);
  return oldest;
}

export class DraftStore {
  private drafts = new Map<string, StoredDraft>();
  /** Las claves que cambiaron aca desde la ultima escritura: lo unico que se escribe. */
  private changed = new Set<string>();
  private writeTimer: NodeJS.Timeout | null = null;
  /** La escritura en curso: van de a una, porque dos se pisarian el temporal. */
  private writing: Promise<void> = Promise.resolve();
  private readonly statePath: string;
  private readonly now: () => number;

  /** Ruta y reloj inyectables para las pruebas; por defecto, la carpeta de configuracion. */
  constructor(options: { statePath?: string; now?: () => number } = {}) {
    this.statePath = options.statePath ?? composerDraftsPath();
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      this.drafts = parseState(await readFile(this.statePath, 'utf8'));
    } catch {
      // Primer arranque, o archivo ilegible: sin borradores.
      this.drafts = new Map();
    }
  }

  /** El borrador guardado de una conversacion, o null. Una copia. */
  get(owner: DraftOwner): ComposerDraft | null {
    const stored = this.drafts.get(keyOf(owner));
    return stored === undefined ? null : copyOf(stored.draft);
  }

  /** Cuantos hay. Para las pruebas. */
  get size(): number {
    return this.drafts.size;
  }

  save(owner: DraftOwner, draft: ComposerDraft): DraftSaveOutcome {
    if (composerDraftChars(draft) > MAX_COMPOSER_DRAFT_CHARS) {
      this.delete(owner);
      return 'too-long';
    }
    if (isEmptyComposerDraft(draft)) return this.delete(owner) ? 'deleted' : 'unchanged';

    const key = keyOf(owner);
    const current = this.drafts.get(key);
    if (current !== undefined && sameComposerDraft(current.draft, draft)) return 'unchanged';
    this.drafts.set(key, { agent: owner.agent, sessionId: owner.sessionId, draft: copyOf(draft), updatedAt: this.now() });
    this.changed.add(key);
    for (const gone of trimOldest(this.drafts)) this.changed.add(gone);
    this.schedule();
    return 'saved';
  }

  /** Borra el de esa conversacion: se mando, o se cerro su pestana. false si no habia. */
  delete(owner: DraftOwner): boolean {
    const key = keyOf(owner);
    if (!this.drafts.delete(key)) return false;
    this.changed.add(key);
    this.schedule();
    return true;
  }

  /**
   * La pestana cambio de conversacion —una CLI que la descubre, o que empieza
   * otra con `/clear`— y su borrador va con ella: es lo que se restaura con la
   * pestana, que desde ahora se guarda con el id nuevo.
   */
  move(from: DraftOwner, to: DraftOwner): void {
    const fromKey = keyOf(from);
    const stored = this.drafts.get(fromKey);
    if (stored === undefined || fromKey === keyOf(to)) return;
    this.delete(from);
    this.save(to, stored.draft);
  }

  /**
   * Deja solo los de estas conversaciones: las pestanas del archivo del
   * arranque. Lo demas es de una pestana que ya no esta —se cerro con una build
   * anterior, o su carpeta se borro— y nadie lo va a pedir.
   */
  retainOnly(owners: Iterable<DraftOwner>): void {
    const keep = new Set([...owners].map(keyOf));
    let removed = false;
    for (const key of [...this.drafts.keys()]) {
      if (keep.has(key)) continue;
      this.drafts.delete(key);
      this.changed.add(key);
      removed = true;
    }
    if (removed) this.schedule();
  }

  /** Escritura inmediata, para el apagado. */
  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    await this.write();
  }

  private schedule(): void {
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.write();
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  private write(): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.changed.size > 0) await this.writeNow();
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  private async writeNow(): Promise<void> {
    // Lo que hay en disco ahora: otra instancia pudo guardar o borrar lo suyo.
    let onDisk = new Map<string, StoredDraft>();
    try {
      onDisk = parseState(await readFile(this.statePath, 'utf8'));
    } catch {
      // Todavia no hay archivo.
    }

    /*
      De aca hasta la escritura no hay ningun `await`: lo que llegue mientras
      tanto cae en el `changed` nuevo y sale en la escritura siguiente.
    */
    const changed = this.changed;
    this.changed = new Set();
    const merged = onDisk;
    for (const key of changed) {
      const mine = this.drafts.get(key);
      if (mine === undefined) merged.delete(key);
      else merged.set(key, mine);
    }
    trimOldest(merged);
    // La memoria aprende lo de la otra instancia: lo que guardo y lo que borro.
    this.drafts = new Map(merged);

    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      // Atomica, como el resto del estado: un corte a mitad no deja medio archivo.
      const temporary = path.join(path.dirname(this.statePath), `composer-drafts.${process.pid}.tmp`);
      const payload = {
        version: STATE_VERSION,
        drafts: [...merged.values()].map(({ agent, sessionId, updatedAt, draft }) => ({ agent, sessionId, updatedAt, draft })),
      };
      // Solo del usuario: lo escrito puede traer cualquier cosa.
      await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.statePath);
    } catch (error) {
      // No se pudo: lo cambiado vuelve a la fila, para el proximo intento.
      for (const key of changed) this.changed.add(key);
      console.warn("[drafts] couldn't save the message box drafts:", error);
    }
  }
}
