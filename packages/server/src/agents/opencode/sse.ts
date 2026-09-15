/**
 * Parser incremental de Server-Sent Events, puro (hito 29).
 *
 * Lo usa el cliente del `serve` de OpenCode para leer `GET /global/event`. No
 * nombra ninguna CLI y no sabe que trae cada evento: devuelve los mensajes tal
 * como los define el formato (`event`, `data`, `id`), y quien lo llama decide
 * cuales entiende.
 *
 * Tres cosas que un parser escrito "por lineas de texto" hace mal, y por eso
 * este trabaja con bytes:
 *
 *  - **Un pedazo corta en cualquier byte.** Decodificar UTF-8 a mitad de un
 *    caracter mete un `�` que ya no se recupera (la misma trampa que §4.11 de
 *    CLAUDE.md con el JSONL). Los fines de linea son bytes ASCII, asi que se
 *    corta por bytes y solo se decodifican lineas completas.
 *  - **`\r\n` puede quedar partido entre dos pedazos.** Leido como dos fines de
 *    linea, el `\n` suelto seria una linea vacia, y una linea vacia despacha el
 *    evento antes de tiempo. Por eso se recuerda si el pedazo anterior termino
 *    en `\r`.
 *  - **Varias lineas `data:` son un solo evento**, unidas con `\n`.
 *
 * Las lineas que empiezan con `:` son comentarios (el latido de un servidor) y
 * se ignoran. `retry` y los campos desconocidos tambien.
 */

export interface SseMessage {
  /** `message` si el evento no trae `event:`. */
  event: string;
  data: string;
  /** El ultimo `id:` visto en el flujo, o null. */
  id: string | null;
}

export interface SseState {
  /** Bytes despues del ultimo fin de linea: una linea que todavia no termino. */
  readonly pending: Uint8Array;
  /** true si el pedazo anterior termino en `\r`: un `\n` al principio no es otra linea. */
  readonly afterCarriageReturn: boolean;
  /** true hasta decodificar la primera linea: ahi se quita un BOM. */
  readonly atStart: boolean;
  readonly dataLines: readonly string[];
  readonly event: string | null;
  readonly lastId: string | null;
}

export const SSE_INITIAL_STATE: SseState = Object.freeze({
  pending: new Uint8Array(0),
  afterCarriageReturn: false,
  atStart: true,
  dataLines: Object.freeze([]) as readonly string[],
  event: null,
  lastId: null,
});

const LF = 0x0a;
const CR = 0x0d;
/** U+FEFF. Por codigo y no como caracter: un BOM literal en el fuente no se ve. */
const BOM = 0xfeff;

const decoder = new TextDecoder('utf-8');

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

/**
 * Consume un pedazo del flujo y devuelve el estado nuevo y los mensajes
 * completos que cerro. No modifica `state`.
 */
export function parseSseChunk(state: SseState, chunk: Uint8Array): { state: SseState; messages: SseMessage[] } {
  const messages: SseMessage[] = [];
  let bytes = concat(state.pending, chunk);
  let afterCarriageReturn = state.afterCarriageReturn;
  let atStart = state.atStart;
  let dataLines = [...state.dataLines];
  let event = state.event;
  let lastId = state.lastId;

  // El `\n` de un `\r\n` que quedo partido entre dos pedazos.
  if (afterCarriageReturn && bytes.length > 0) {
    if (bytes[0] === LF) bytes = bytes.subarray(1);
    afterCarriageReturn = false;
  }

  let lineStart = 0;
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte !== LF && byte !== CR) {
      index++;
      continue;
    }

    let line = decoder.decode(bytes.subarray(lineStart, index));
    if (atStart) {
      if (line.charCodeAt(0) === BOM) line = line.slice(1);
      atStart = false;
    }

    if (byte === CR) {
      if (index + 1 < bytes.length) {
        if (bytes[index + 1] === LF) index++;
      } else {
        afterCarriageReturn = true;
      }
    }
    index++;
    lineStart = index;

    if (line.length === 0) {
      if (dataLines.length > 0) messages.push({ event: event ?? 'message', data: dataLines.join('\n'), id: lastId });
      dataLines = [];
      event = null;
      continue;
    }
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) lastId = value;
  }

  return {
    state: {
      pending: bytes.slice(lineStart),
      afterCarriageReturn,
      atStart,
      dataLines,
      event,
      lastId,
    },
    messages,
  };
}
