/**
 * Los mensajes programados en disco (hito 51, §6.39).
 *
 * Dos archivos en la carpeta de configuracion propia, nunca en la de una CLI:
 *
 *  - `scheduled-messages.json`: cada mensaje con su conversacion, su texto, su
 *    hora y, si fallo, por que. Lo que esta esperando o mandandose no se
 *    guarda: es de la instancia que lo hace.
 *  - `scheduled-claims/<id>.json`: quien lo esta mandando. Lo crea en exclusiva
 *    (`wx`) la instancia que se pone a mandarlo, con su pid y el paso en que va
 *    (`reserved` mientras espera al agente, `writing` desde que empieza a
 *    mandarlo). Dos instancias comparten la carpeta (`pnpm dev` al lado de la de
 *    uso, §14.8) y sin esto las dos lo mandarian.
 *
 * Tres reglas, cada una por algo que se sabe que pasa:
 *
 *  - **Cada cambio relee el archivo y cambia solo lo suyo**, como los
 *    borradores (§6.29): reescribirlo con lo de la memoria borraria lo que
 *    programo la otra instancia.
 *  - **Un reclamo de un proceso muerto se toma o se declara**: si estaba en
 *    `reserved`, no se escribio nada y otra instancia lo puede tomar; si estaba
 *    en `writing`, no se sabe si llego, y no se reintenta nunca.
 *  - **Una version desconocida del archivo se lee como vacia** y se reescribe
 *    con el primer cambio, como las notas y los borradores.
 */

import {
  AGENT_IDS,
  MAX_SCHEDULED_TEXT_CHARS,
  asArrayFiltered,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
  parseServerText,
  type AgentId,
  type ServerText,
} from '@agent-workbench/shared';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { scheduledClaimsDir, scheduledMessagesPath } from '../paths.js';
import { processAlive } from '../process-alive.js';
import { writeFileAtomic } from '../vault/write.js';

const STATE_VERSION = 1;

/** El id de un mensaje: lo genera el servidor (`randomUUID`). Otra forma no se lee, ni se usa como nombre de archivo. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isScheduledMessageId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** De que conversacion es un mensaje programado. La misma clave que un borrador. */
export interface ScheduleOwner {
  agent: string;
  sessionId: string;
}

export interface StoredScheduledMessage {
  id: string;
  agent: AgentId;
  sessionId: string;
  text: string;
  sendAt: number;
  createdAt: number;
  /** Por que no se envio. Ausente mientras se puede mandar. */
  failure?: ServerText;
}

/** En que paso va la instancia que lo reclamo. */
export type ClaimPhase = 'reserved' | 'writing';

export interface ClaimInfo {
  pid: number;
  phase: ClaimPhase;
  /** true si es de este proceso. */
  mine: boolean;
  /** true si ese proceso sigue vivo. */
  alive: boolean;
}

/**
 * Como termino un intento de reclamar:
 *
 *  - `mine`: es de este proceso (recien creado, o ya lo era).
 *  - `other`: lo tiene otra instancia viva.
 *  - `orphan-writing`: lo tenia un proceso que murio escribiendo. No se toma:
 *    no se sabe si llego.
 */
export type ClaimResult = 'mine' | 'other' | 'orphan-writing';

function sameOwner(a: ScheduleOwner, b: ScheduleOwner): boolean {
  return a.agent === b.agent && a.sessionId === b.sessionId;
}

function parseEntry(value: unknown): StoredScheduledMessage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const agent = asLiteral(record['agent'], AGENT_IDS);
  const sessionId = asNonEmptyString(record['sessionId']);
  const text = asString(record['text']);
  const sendAt = asFiniteNumber(record['sendAt']);
  const createdAt = asFiniteNumber(record['createdAt']);
  if (id === null || !isScheduledMessageId(id) || agent === null || sessionId === null) return null;
  if (text === null || text.length === 0 || text.length > MAX_SCHEDULED_TEXT_CHARS) return null;
  if (sendAt === null || createdAt === null) return null;
  const message: StoredScheduledMessage = { id, agent, sessionId, text, sendAt, createdAt };
  if (record['failure'] !== undefined) {
    const failure = parseServerText(record['failure']);
    // Una falla que no se entiende sigue siendo una falla: no se manda solo.
    message.failure = failure ?? { key: 'scheduledUncertain' };
  }
  return message;
}

/** Los mensajes del archivo. Ilegible o de otra version, ninguno. Pura: la prueba el chequeo. */
export function parseScheduledState(raw: string): StoredScheduledMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  if (record === null || record['version'] !== STATE_VERSION) return [];
  const seen = new Set<string>();
  const messages: StoredScheduledMessage[] = [];
  // Uno mal formado se descarta solo: no se lleva los de las demas conversaciones.
  for (const message of asArrayFiltered(record['messages'], parseEntry) ?? []) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    messages.push(message);
  }
  return messages;
}

function copyOf(message: StoredScheduledMessage): StoredScheduledMessage {
  return message.failure === undefined ? { ...message } : { ...message, failure: { ...message.failure } };
}

export interface ScheduledMessageStoreOptions {
  statePath?: string;
  claimsDir?: string;
  /** El pid de este proceso. Inyectable para el chequeo, que hace de dos instancias. */
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

export class ScheduledMessageStore {
  private messages: StoredScheduledMessage[] = [];
  /** Fecha y tamano del archivo la ultima vez que se leyo: si cambian, lo cambio otra instancia. */
  private stamp = '';
  /** Los cambios, en fila: cada uno relee lo que dejo el anterior. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly statePath: string;
  private readonly claimsDir: string;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(options: ScheduledMessageStoreOptions = {}) {
    this.statePath = options.statePath ?? scheduledMessagesPath();
    this.claimsDir = options.claimsDir ?? scheduledClaimsDir();
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? processAlive;
  }

  async load(): Promise<void> {
    await this.readDisk();
  }

  /** Una copia de cada uno. */
  list(): StoredScheduledMessage[] {
    return this.messages.map(copyOf);
  }

  get(id: string): StoredScheduledMessage | null {
    const found = this.messages.find((message) => message.id === id);
    return found === undefined ? null : copyOf(found);
  }

  get size(): number {
    return this.messages.length;
  }

  /** Relee el archivo si cambio desde la ultima vez (lo cambio otra instancia). true si cambio. */
  async refresh(): Promise<boolean> {
    if ((await this.currentStamp()) === this.stamp) return false;
    const before = JSON.stringify(this.messages);
    await this.readDisk();
    return JSON.stringify(this.messages) !== before;
  }

  add(message: StoredScheduledMessage): Promise<void> {
    return this.mutate((messages) => {
      messages.push(copyOf(message));
      return undefined;
    });
  }

  /** Saca uno. Devuelve el que estaba, o null. */
  remove(id: string): Promise<StoredScheduledMessage | null> {
    return this.mutate((messages) => {
      const index = messages.findIndex((message) => message.id === id);
      if (index === -1) return null;
      const [removed] = messages.splice(index, 1);
      return removed === undefined ? null : copyOf(removed);
    });
  }

  /** Cambia la hora o la falla de uno. null si ya no esta. */
  update(id: string, change: { sendAt?: number; failure?: ServerText | null }): Promise<StoredScheduledMessage | null> {
    return this.mutate((messages) => {
      const message = messages.find((entry) => entry.id === id);
      if (message === undefined) return null;
      if (change.sendAt !== undefined) message.sendAt = change.sendAt;
      if (change.failure === null) delete message.failure;
      else if (change.failure !== undefined) message.failure = { ...change.failure };
      return copyOf(message);
    });
  }

  /** Saca los de una conversacion: se cerro su pestana. Devuelve los que saco. */
  removeOwner(owner: ScheduleOwner): Promise<StoredScheduledMessage[]> {
    return this.mutate((messages) => {
      const removed = messages.filter((message) => sameOwner(message, owner));
      if (removed.length === 0) return removed;
      const kept = messages.filter((message) => !sameOwner(message, owner));
      messages.splice(0, messages.length, ...kept);
      return removed.map(copyOf);
    });
  }

  /**
   * La pestana cambio de conversacion (`/clear`): sus mensajes van con ella,
   * como el borrador (§6.29). Solo pasa entre CLIs iguales: el id es de una.
   */
  move(from: ScheduleOwner, to: ScheduleOwner): Promise<number> {
    if (sameOwner(from, to) || from.agent !== to.agent) return Promise.resolve(0);
    return this.mutate((messages) => {
      let moved = 0;
      for (const message of messages) {
        if (!sameOwner(message, from)) continue;
        message.sessionId = to.sessionId;
        moved += 1;
      }
      return moved;
    });
  }

  /**
   * Deja solo los de estas conversaciones: las pestanas del archivo del
   * arranque. Lo demas es de una pestana que se cerro con una build anterior,
   * que no los borra, y no lo va a mostrar nadie.
   */
  retainOnly(owners: Iterable<ScheduleOwner>): Promise<number> {
    const keep = [...owners];
    return this.mutate((messages) => {
      const kept = messages.filter((message) => keep.some((owner) => sameOwner(message, owner)));
      const dropped = messages.length - kept.length;
      if (dropped > 0) messages.splice(0, messages.length, ...kept);
      return dropped;
    });
  }

  /** Espera a que se escriba lo pendiente, para el apagado. */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  // ---- quien lo esta mandando ----

  /**
   * Reclama un mensaje para este proceso, en `reserved`. Un reclamo de un
   * proceso muerto en `reserved` se borra y se vuelve a intentar: ese proceso no
   * escribio nada.
   */
  async claim(id: string): Promise<ClaimResult> {
    if (!isScheduledMessageId(id)) return 'other';
    await mkdir(this.claimsDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.claimPath(id), 'wx');
        try {
          await handle.writeFile(this.claimBody('reserved'));
        } finally {
          await handle.close();
        }
        return 'mine';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const existing = await this.claimOf(id);
      if (existing === null) continue;
      if (existing.mine) return 'mine';
      if (existing.alive) return 'other';
      if (existing.phase === 'writing') return 'orphan-writing';
      await rm(this.claimPath(id), { force: true });
    }
    return 'other';
  }

  /** Pasa un reclamo propio a otro paso. */
  async setPhase(id: string, phase: ClaimPhase): Promise<void> {
    const existing = await this.claimOf(id);
    if (existing === null || !existing.mine) return;
    await writeFileAtomic(this.claimPath(id), this.claimBody(phase));
  }

  /** Suelta un reclamo propio. El de otra instancia no se toca. */
  async release(id: string): Promise<void> {
    const existing = await this.claimOf(id);
    if (existing === null || !existing.mine) return;
    await rm(this.claimPath(id), { force: true });
  }

  /** Borra el reclamo de un proceso muerto, ya declarado. El de uno vivo no se toca. */
  async discardOrphan(id: string): Promise<void> {
    const existing = await this.claimOf(id);
    if (existing === null || existing.mine || existing.alive) return;
    await rm(this.claimPath(id), { force: true });
  }

  /** El reclamo de un mensaje, o null si no hay (o no se entiende: se trata como ausente). */
  async claimOf(id: string): Promise<ClaimInfo | null> {
    if (!isScheduledMessageId(id)) return null;
    let raw: string;
    try {
      raw = await readFile(this.claimPath(id), 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A medio escribir: lo esta creando otra instancia en este instante.
      return { pid: -1, phase: 'reserved', mine: false, alive: true };
    }
    const record = asRecord(parsed);
    const pid = record === null ? null : asFiniteNumber(record['pid']);
    const phase = record === null ? null : asLiteral(record['phase'], ['reserved', 'writing'] as const);
    if (pid === null || phase === null) return { pid: -1, phase: 'reserved', mine: false, alive: true };
    const mine = pid === this.pid;
    return { pid, phase, mine, alive: mine || this.isAlive(pid) };
  }

  /** Los ids que tienen reclamo en disco. Para limpiar los de mensajes que ya no estan. */
  async claimedIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.claimsDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isScheduledMessageId);
  }

  /** Suelta los reclamos propios en `reserved`: la instancia se apaga sin haber escrito nada. */
  async releaseReserved(): Promise<void> {
    for (const id of await this.claimedIds()) {
      const existing = await this.claimOf(id);
      if (existing !== null && existing.mine && existing.phase === 'reserved') await rm(this.claimPath(id), { force: true });
    }
  }

  // ---- disco ----

  private claimPath(id: string): string {
    return path.join(this.claimsDir, `${id}.json`);
  }

  private claimBody(phase: ClaimPhase): string {
    return `${JSON.stringify({ pid: this.pid, phase, at: Date.now() })}\n`;
  }

  private async currentStamp(): Promise<string> {
    try {
      const info = await stat(this.statePath);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return '';
    }
  }

  private async readDisk(): Promise<StoredScheduledMessage[]> {
    const stamp = await this.currentStamp();
    let messages: StoredScheduledMessage[] = [];
    try {
      messages = parseScheduledState(await readFile(this.statePath, 'utf8'));
    } catch {
      // Sin archivo: ninguno.
    }
    this.messages = messages;
    this.stamp = stamp;
    return messages;
  }

  /** Relee, aplica el cambio y escribe. Lo que devuelve `change` es lo que devuelve el cambio. */
  private mutate<T>(change: (messages: StoredScheduledMessage[]) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const messages = await this.readDisk();
      const before = JSON.stringify(messages);
      const result = change(messages);
      if (JSON.stringify(messages) === before) return result;
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFileAtomic(this.statePath, `${JSON.stringify({ version: STATE_VERSION, messages }, null, 2)}\n`);
      this.messages = messages;
      this.stamp = await this.currentStamp();
      return result;
    };
    const result = this.queue.then(run, run);
    // Un cambio que fallo no frena a los que vienen detras.
    this.queue = result.catch(() => undefined);
    return result;
  }
}
