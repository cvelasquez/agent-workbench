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
 */

import { open, stat } from 'node:fs/promises';
import type { ConversationEvent, ConversationState } from '@agent-workbench/shared';
import { parseJsonlLine } from '../jsonl-reader.js';
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

  /**
   * `filePath` null: todavia no se sabe que archivo es (una CLI que pone el id
   * de sesion ella misma). Hasta `setPath` no se lee nada y el estado es
   * `waiting`.
   */
  constructor(
    filePath: string | null,
    private readonly sink: JsonlLineSink,
    options: { maxEvents?: number } = {},
  ) {
    this.path = filePath;
    this.maxEvents = options.maxEvents ?? MAX_EVENTS;
  }

  get filePath(): string | null {
    return this.path;
  }

  /**
   * Fija la ruta de una sesion que se descubrio despues de empezar a seguirla.
   *
   * Solo vale una vez: cambiar de archivo con eventos ya entregados mezclaria
   * dos conversaciones en la misma vista. Quien necesite eso crea otro seguidor.
   */
  setPath(filePath: string): void {
    if (this.path !== null) {
      throw new Error(`El seguidor ya tiene archivo: ${this.path}`);
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
    const events = this.events.slice(-limit);
    return {
      events,
      hasMore: this.events.length > events.length || this.dropped > 0,
    };
  }

  /** Tramo anterior a un evento ya entregado. Vacio si ese id ya no esta. */
  getPageBefore(beforeEventId: string, limit: number): EventPage {
    const index = this.events.findIndex((event) => event.eventId === beforeEventId);
    if (index <= 0) return { events: [], hasMore: false };

    const start = Math.max(0, index - limit);
    return {
      events: this.events.slice(start, index),
      hasMore: start > 0 || this.dropped > 0,
    };
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
      const info = await stat(this.path);
      size = info.size;
    } catch {
      // Todavia no existe, o lo borraron. Si teniamos algo, se descarta.
      if (this.events.length > 0 || this.offset > 0) {
        this.reset();
        this.state = 'waiting';
        return { reset: true, added: [] };
      }
      this.state = 'waiting';
      return { reset: false, added: [] };
    }

    let didReset = false;
    if (size < this.offset) {
      // Reemplazado o truncado: lo que sabiamos ya no vale.
      this.reset();
      didReset = true;
    }

    this.state = 'live';
    if (size === this.offset) {
      return { reset: didReset, added: [] };
    }

    const added = await this.readFrom(this.path, size);
    return { reset: didReset, added };
  }

  private reset(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.lineNumber = 0;
    this.events = [];
    this.dropped = 0;
    this.sink.reset();
  }

  private async readFrom(filePath: string, size: number): Promise<ConversationEvent[]> {
    const added: ConversationEvent[] = [];
    const handle = await open(filePath, 'r');

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
    } finally {
      await handle.close();
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
