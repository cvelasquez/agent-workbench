/**
 * Seguimiento incremental de un archivo JSONL, sin saber de que CLI es.
 *
 * Guarda el offset en bytes y lee **solo lo nuevo**. Releer el archivo entero
 * en cada cambio no es una optimizacion prematura que nos ahorramos: la CLI
 * escribe en cada turno y hay sesiones de 2,9 MB, asi que releerlas completas
 * cada vez es releer megabytes por cada linea que se agrega.
 *
 * Lo que cada linea *significa* no vive aca: lo decide un `JsonlLineSink`, uno
 * por formato. Esta clase solo corta lineas, las numera, las parsea, guarda los
 * eventos que el sink devuelve y los pagina. Se extrajo del seguidor de Claude
 * Code sin cambiar nada observable (§8.2 del hito 25): lo prueba
 * `check-conversation-follower.mjs`, que no se toco.
 *
 * Tres detalles que hacen la diferencia entre que esto funcione y que se rompa
 * cada tanto de forma dificil de reproducir (§4.11 de CLAUDE.md):
 *
 *  - **El resto parcial se guarda como `Buffer`, no como string.** Una lectura
 *    corta en cualquier byte, y decodificar UTF-8 a mitad de un caracter deja
 *    un `�` en el medio del texto. Solo se decodifican lineas completas.
 *  - **Si el archivo encoge, se reinicia.** Significa que lo reemplazaron o lo
 *    truncaron; seguir leyendo desde el offset viejo devolveria basura.
 *  - **El numero de linea cuenta todas las lineas**, vacias e invalidas
 *    incluidas. De ahi sale el `eventId` de respaldo (`line-<n>`), y contar
 *    distinto cambiaria los ids de conversaciones que ya se entregaron.
 *
 * Y dos opciones que solo usa quien las pide. La **huella** (`fingerprintBytes`,
 * hito 27): una CLI que reescribe su historial entero —Antigravity al compactar
 * el contexto— puede dejarlo del mismo tamano o mas grande, y ahi el offset no
 * se entera. Con huella, los primeros bytes se comparan en cada lectura y si
 * cambiaron es un reinicio. Sin la opcion (Claude Code, Codex) no se lee nada de
 * mas. Y **dejar el archivo abierto** (`keepOpen`, §4.11.1): abrirlo en cada
 * lectura le cuesta a una sesion larga lo que tarde el antivirus en revisarla.
 */

import type { ConversationEvent, ConversationState } from '@agent-workbench/shared';
import { DISK_FILES, parseJsonlLine, type JsonlFileAccess, type JsonlHandle } from '../jsonl-reader.js';
import type { EventPage } from './adapter.js';

/** Bloque de lectura. Las lineas largas (hasta 290 KB) igual se arman a mano. */
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Tope de eventos en memoria por sesion.
 *
 * Una sesion larga tiene ~10.000 lineas. Con el recorte por parte cada evento
 * pesa poco, pero el tope evita que una sesion enorme y una app abierta todo el
 * dia terminen en cientos de MB. Se descartan los mas viejos.
 */
const MAX_EVENTS = 4_000;

const NEWLINE = 0x0a;

/** Los eventos ya guardados, para que el sink pueda corregir uno anterior. */
export interface EventLookup {
  find(eventId: string): ConversationEvent | undefined;
}

/** Lo que interpreta cada linea de un formato concreto. */
export interface JsonlLineSink {
  /**
   * Una linea completa y parseada. Devuelve el evento nuevo o null. Nunca lanza:
   * el esquema cambia entre versiones de la CLI.
   *
   * `lineNumber` es 1-based y cuenta tambien las lineas vacias e invalidas.
   */
  consume(
    record: Record<string, unknown>,
    lineNumber: number,
    events: EventLookup,
  ): ConversationEvent | null;
  /** El archivo encogio o desaparecio: olvidar lo acumulado. */
  reset(): void;
}

export interface JsonlPollResult {
  /** true si el archivo se reemplazo: el cliente tiene que rehacer su vista. */
  reset: boolean;
  added: ConversationEvent[];
}

export interface JsonlFollowerOptions {
  maxEvents?: number;
  /**
   * Cuantos bytes del principio del archivo forman la huella. 0 (el valor por
   * defecto): sin huella, y ninguna lectura de mas.
   *
   * Con huella, en cuanto el archivo llega a ese tamano se guardan sus primeros
   * bytes, y cada `poll` los vuelve a leer: si difieren, el archivo se
   * reescribio aunque no haya encogido, y se reinicia igual que si encogiera.
   */
  fingerprintBytes?: number;
  /**
   * Como se llega a los bytes. Ausente: el disco tal cual. Codex pasa uno que
   * entrega descomprimido un rollout `.jsonl.zst` (§10.12).
   */
  files?: JsonlFileAccess;
  /**
   * Que eventos ya guardados se entregan (hito 44). Ausente: todos. Claude Code
   * esconde los de una rama que la CLI abandono (§4.16): siguen guardados, por
   * si la rama vuelve, y no salen ni en las paginas ni en lo nuevo de un `poll`.
   */
  isVisible?: (event: ConversationEvent) => boolean;
  /**
   * Deja el archivo abierto entre lecturas, y quien lo pide lo cierra con
   * `close()` (§4.11.1). Medido el 28-10-2026: con un antivirus que revisa el
   * archivo entero cuando otro proceso lo abre despues de un cambio, abrir una
   * sesion de 86 MB tardaba 68 s, cada vez que la CLI escribia; leer por un
   * archivo ya abierto, 0 ms. Solo con un acceso que sepa la identidad del
   * archivo (`JsonlFileAccess.identity`): sin ella no se puede saber si la CLI
   * lo reemplazo, y se abre en cada lectura como siempre.
   */
  keepOpen?: boolean;
}

export class JsonlFollower implements EventLookup {
  private path: string | null;
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private lineNumber = 0;
  private events: ConversationEvent[] = [];
  /** Eventos viejos que se descartaron por el tope. Solo para saber si hay mas. */
  private dropped = 0;
  private state: ConversationState = 'waiting';
  private readonly maxEvents: number;
  private readonly fingerprintBytes: number;
  /** Los primeros `fingerprintBytes` del archivo leido; null sin huella o si todavia no llego a ese tamano. */
  private fingerprint: Buffer | null = null;
  private readonly files: JsonlFileAccess;
  private readonly isVisible: ((event: ConversationEvent) => boolean) | null;
  private readonly keepOpen: boolean;
  /** El archivo que se deja abierto (`keepOpen`) y que archivo es; null si no hay ninguno abierto. */
  private held: { handle: JsonlHandle; identity: string } | null = null;

  /**
   * `filePath` null: todavia no se sabe que archivo es (una CLI que pone el id
   * de sesion ella misma). Hasta `setPath` no se lee nada y el estado es
   * `waiting`.
   */
  constructor(
    filePath: string | null,
    private readonly sink: JsonlLineSink,
    options: JsonlFollowerOptions = {},
  ) {
    this.path = filePath;
    this.maxEvents = options.maxEvents ?? MAX_EVENTS;
    this.fingerprintBytes = Math.max(0, Math.floor(options.fingerprintBytes ?? 0));
    this.files = options.files ?? DISK_FILES;
    this.isVisible = options.isVisible ?? null;
    this.keepOpen = options.keepOpen === true && this.files.identity !== undefined;
  }

  get filePath(): string | null {
    return this.path;
  }

  /**
   * Cuantos bytes del archivo ya se leyeron, lineas a medias incluidas. 0 con un
   * archivo vacio: es lo que distingue "existe pero no tiene nada" de "tiene".
   */
  get bytesRead(): number {
    return this.offset;
  }

  /**
   * Fija la ruta de una sesion que se descubrio despues de empezar a seguirla.
   *
   * Solo vale una vez: cambiar de archivo con eventos ya entregados mezclaria
   * dos conversaciones en la misma vista. Quien necesite eso crea otro seguidor.
   */
  setPath(filePath: string): void {
    if (this.path !== null) {
      throw new Error(`The follower already has a file: ${this.path}`);
    }
    this.path = filePath;
  }

  getState(): ConversationState {
    return this.state;
  }

  find(eventId: string): ConversationEvent | undefined {
    return this.events.find((event) => event.eventId === eventId);
  }

  eventCount(): number {
    return this.events.length;
  }

  /** Ultimos `limit` eventos, que es lo que se quiere ver al abrir el panel. */
  getTail(limit: number): EventPage {
    const visible = this.visibleEvents();
    const events = visible.slice(-limit);
    return {
      events,
      hasMore: visible.length > events.length || this.dropped > 0,
    };
  }

  /** Tramo anterior a un evento ya entregado. Vacio si ese id ya no esta. */
  getPageBefore(beforeEventId: string, limit: number): EventPage {
    const visible = this.visibleEvents();
    const index = visible.findIndex((event) => event.eventId === beforeEventId);
    if (index <= 0) return { events: [], hasMore: false };

    const start = Math.max(0, index - limit);
    return {
      events: visible.slice(start, index),
      hasMore: start > 0 || this.dropped > 0,
    };
  }

  /** Los eventos que se entregan: todos, salvo los que `isVisible` deja afuera. */
  private visibleEvents(): ConversationEvent[] {
    return this.isVisible === null ? this.events : this.events.filter(this.isVisible);
  }

  /**
   * Lee lo que haya de nuevo.
   *
   * No lanza si el archivo no existe: entre que se abre una pestana y el
   * usuario manda el primer mensaje, no existe, y eso es lo normal. Si lanza
   * al leer un archivo que si existe, lanza: el hub lo loguea.
   */
  async poll(): Promise<JsonlPollResult> {
    if (this.path === null) {
      this.state = 'waiting';
      return { reset: false, added: [] };
    }

    let size: number;
    try {
      size = await this.files.size(this.path);
    } catch {
      // Todavia no existe, o lo borraron. Si teniamos algo, se descarta.
      await this.close();
      if (this.events.length > 0 || this.offset > 0) {
        this.reset();
        this.state = 'waiting';
        return { reset: true, added: [] };
      }
      this.state = 'waiting';
      return { reset: false, added: [] };
    }

    let didReset = false;
    if (this.held !== null && !(await this.holdsFileAt(this.path, this.held.identity))) {
      // La CLI puso otro archivo en la ruta: el abierto ya no es el de la sesion.
      await this.close();
      this.reset();
      didReset = true;
    } else if (size < this.offset) {
      // Reemplazado o truncado: lo que sabiamos ya no vale.
      this.reset();
      didReset = true;
    } else if (this.fingerprint !== null && !(await this.sameFingerprint(this.path, this.fingerprint))) {
      // Reescrito sin encoger: el principio ya no es el que se leyo.
      this.reset();
      didReset = true;
    }

    this.state = 'live';
    if (size === this.offset) {
      return { reset: didReset, added: [] };
    }

    const added = await this.readFrom(this.path, size);
    return { reset: didReset, added: this.isVisible === null ? added : added.filter(this.isVisible) };
  }

  private reset(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.lineNumber = 0;
    this.events = [];
    this.dropped = 0;
    this.fingerprint = null;
    this.sink.reset();
  }

  /**
   * Cierra el archivo que se dejo abierto (`keepOpen`). Lo llama quien pidio
   * dejarlo abierto, al soltar la sesion; la lectura siguiente, si la hay, lo
   * vuelve a abrir. No lanza.
   */
  async close(): Promise<void> {
    const held = this.held;
    this.held = null;
    await held?.handle.close().catch(() => undefined);
  }

  /** true si en `filePath` sigue el archivo de identidad `identity`. */
  private async holdsFileAt(filePath: string, identity: string): Promise<boolean> {
    try {
      return (await this.files.identity?.(filePath)) === identity;
    } catch {
      return false;
    }
  }

  /**
   * El archivo para leer: el que se dejo abierto, o uno recien abierto. Con
   * `keepOpen` y una identidad conocida, el recien abierto queda abierto; si no,
   * quien lo pidio lo cierra con `done`.
   */
  private async acquire(filePath: string): Promise<JsonlHandle> {
    if (this.held !== null) return this.held.handle;
    const handle = await this.files.open(filePath);
    if (!this.keepOpen) return handle;
    const identity = await handle.identity?.().catch(() => '');
    if (identity !== undefined && identity.length > 0) this.held = { handle, identity };
    return handle;
  }

  /** Termino una lectura: se cierra lo abierto, salvo el que se deja abierto. */
  private async done(handle: JsonlHandle, failed: boolean): Promise<void> {
    if (this.held?.handle !== handle) {
      await handle.close();
      return;
    }
    // Una lectura que fallo no deja nada abierto: la siguiente empieza de cero.
    if (failed) await this.close();
  }

  /** true si el archivo todavia empieza con `expected`. */
  private async sameFingerprint(filePath: string, expected: Buffer): Promise<boolean> {
    const handle = await this.acquire(filePath);
    let failed = true;
    try {
      const head = Buffer.alloc(expected.length);
      const { bytesRead } = await handle.read(head, 0, expected.length, 0);
      failed = false;
      return bytesRead === expected.length && head.equals(expected);
    } finally {
      await this.done(handle, failed);
    }
  }

  private async readFrom(filePath: string, size: number): Promise<ConversationEvent[]> {
    const added: ConversationEvent[] = [];
    const handle = await this.acquire(filePath);
    let failed = true;

    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

      while (this.offset < size) {
        const toRead = Math.min(READ_CHUNK_BYTES, size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;

        // Copia explicita: `buffer` se reusa en la vuelta siguiente.
        const combined = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);

        let start = 0;
        let newlineIndex = combined.indexOf(NEWLINE, start);
        while (newlineIndex !== -1) {
          const line = combined.subarray(start, newlineIndex).toString('utf8');
          start = newlineIndex + 1;
          const event = this.consumeLine(line);
          if (event !== null) added.push(event);
          newlineIndex = combined.indexOf(NEWLINE, start);
        }

        // El resto queda pendiente hasta que llegue su salto de linea.
        this.pending = Buffer.from(combined.subarray(start));
      }

      // La huella se toma una vez, con el mismo handle, cuando ya hay bytes para ella.
      if (this.fingerprintBytes > 0 && this.fingerprint === null && this.offset >= this.fingerprintBytes) {
        const head = Buffer.alloc(this.fingerprintBytes);
        const { bytesRead } = await handle.read(head, 0, this.fingerprintBytes, 0);
        if (bytesRead === this.fingerprintBytes) this.fingerprint = head;
      }
      failed = false;
    } finally {
      await this.done(handle, failed);
    }

    return added;
  }

  /** Una linea completa: se numera, se parsea y va al sink. */
  private consumeLine(rawLine: string): ConversationEvent | null {
    const line = rawLine.trim();
    // Antes de mirar si esta vacia: los ids `line-<n>` dependen de esto.
    this.lineNumber += 1;
    if (line.length === 0) return null;

    const record = parseJsonlLine(line);
    if (record === null) return null;

    const event = this.sink.consume(record, this.lineNumber, this);
    if (event === null) return null;

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
      this.dropped += 1;
    }
    return event;
  }
}
