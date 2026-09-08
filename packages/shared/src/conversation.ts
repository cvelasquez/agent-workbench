/**
 * Modelo de la vista de conversacion.
 *
 * Lo que viaja al navegador NO es la linea del JSONL: es una version recortada
 * y estrechada de ella. Tres motivos, todos medidos sobre la instalacion real:
 *
 *  1. Una sola linea puede pesar 290 KB (un adjunto, un resultado de
 *     herramienta enorme). Mandarla entera al navegador no aporta nada y
 *     cuelga la pestana. Cada parte se recorta y se marca `truncated`.
 *  2. Los bloques `thinking` **vienen vacios**: medidos 248 en 230 sesiones, 0
 *     con texto. El JSONL guarda la firma, no el razonamiento. Por eso
 *     `ConversationThinkingPart` no tiene contenido: no hay ninguno que
 *     mostrar, y una tarjeta que promete razonamiento y muestra vacio es peor
 *     que no tenerla.
 *  3. El esquema cambia entre versiones de la CLI. Lo que no se reconoce se
 *     ignora en silencio; nunca se lanza.
 */

import {
  asArrayOf,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
} from './validation.js';

/** Quien habla. Los tipos de linea que no son mensajes ni llegan hasta aca. */
export type ConversationRole = 'user' | 'assistant';

export const CONVERSATION_ROLES: readonly ConversationRole[] = ['user', 'assistant'];

export interface ConversationTextPart {
  kind: 'text';
  text: string;
  /** true si el texto original era mas largo que el tope de transporte. */
  truncated: boolean;
}

export interface ConversationToolCallPart {
  kind: 'tool-call';
  /** Casa con el `tool-result` que llega despues, en otro evento. */
  toolUseId: string;
  name: string;
  /** Entrada de la herramienta, ya serializada a texto. */
  input: string;
  truncated: boolean;
}

export interface ConversationToolResultPart {
  kind: 'tool-result';
  toolUseId: string;
  text: string;
  isError: boolean;
  truncated: boolean;
  /**
   * Cuantas imagenes traia el resultado. Las imagenes NO se transportan: son
   * base64 de cientos de KB y el panel es un resumen navegable, no un visor.
   */
  imageCount: number;
}

/** Marcador de que hubo razonamiento. Sin contenido: el JSONL no lo guarda. */
export interface ConversationThinkingPart {
  kind: 'thinking';
}

/** Una opcion de una pregunta de eleccion. */
export interface ConversationQuestionOption {
  label: string;
  description: string;
}

/** Una de las preguntas de una misma llamada. */
export interface ConversationQuestionItem {
  question: string;
  /** Etiqueta corta; es lo que la CLI dibuja como solapa. */
  header: string;
  multiSelect: boolean;
  options: ConversationQuestionOption[];
}

/**
 * Una pregunta de eleccion que la CLI le esta haciendo al usuario.
 *
 * Es un `tool_use` como cualquier otro, pero **no se dibuja como uno**: es lo
 * unico del hilo que espera una accion en vez de contar algo que ya paso. Con
 * la tarjeta generica —nombre colapsado y el JSON crudo adentro— la pregunta
 * llegaba ilegible y la unica forma de contestar era ir a la solapa CLI.
 *
 * **Se estructura en el servidor, no en el navegador.** La entrada de una
 * herramienta viaja recortada a 2000 caracteres, y una llamada con tres o
 * cuatro preguntas pasa ese tope: el JSON llegaria cortado y no parsearia. Aca
 * llega ya en piezas, y el recorte no lo puede romper.
 *
 * Si el input no tiene esta forma —otra version de la CLI, un campo que
 * cambio— no se emite esta parte y la llamada cae a `tool-call`, que sigue
 * mostrando lo mismo que mostraba antes. Desconocido no rompe (§4.4).
 */
export interface ConversationQuestionPart {
  kind: 'question';
  /** Casa con el `tool-result` que llega cuando la pregunta se responde. */
  toolUseId: string;
  questions: ConversationQuestionItem[];
}

/**
 * De donde salen los bytes de una imagen del usuario.
 *
 * Son **dos formas distintas** en el mismo archivo, y por eso hay que
 * distinguirlas:
 *
 *  - `content`: un bloque `{"type":"image"}` dentro de `message.content`. Es lo
 *    que deja pegar con `Alt+V` en la solapa CLI.
 *  - `attachment`: una linea `attachment` **aparte**, con `parentUuid`
 *    apuntando al mensaje. Es lo que deja el cuadro de escritura, que nombra la
 *    imagen por ruta (§5.3) y hace que la CLI la adjunte ella.
 *
 * Un mismo mensaje puede traer de las dos, y cada forma tiene su propia
 * numeracion: sin este campo, la imagen 0 de una taparia a la 0 de la otra.
 */
export type ConversationImageSource = 'content' | 'attachment';

export const CONVERSATION_IMAGE_SOURCES: readonly ConversationImageSource[] = [
  'content',
  'attachment',
];

/**
 * Una imagen de un mensaje del usuario.
 *
 * **Sin bytes.** El JSONL las guarda en base64 y pesan cientos de KB; mandarlas
 * con cada evento haria que abrir una conversacion vieja arrastrara todas las
 * capturas que se pegaron alguna vez. Viaja la referencia, y el contenido se
 * pide aparte cuando alguien mira esa miniatura.
 *
 * `index` es la posicion dentro de su fuente: junto al `eventId` y al `source`
 * identifica la imagen sin inventar ningun id nuevo.
 */
export interface ConversationImagePart {
  kind: 'image';
  index: number;
  mediaType: string;
  source: ConversationImageSource;
}

export type ConversationPart =
  | ConversationTextPart
  | ConversationToolCallPart
  | ConversationToolResultPart
  | ConversationThinkingPart
  | ConversationQuestionPart
  | ConversationImagePart;

/** `message.usage` de una linea de asistente, con los nombres normalizados. */
export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ConversationEvent {
  /** `uuid` de la linea. Sintetico si la linea no traia uno. */
  eventId: string;
  role: ConversationRole;
  /** Epoch ms. 0 si la linea no traia timestamp. */
  at: number;
  parts: ConversationPart[];
  /** Solo en asistente, y puede ser un id que ni la CLI reconoce. */
  model: string | null;
  usage: MessageUsage | null;
  /**
   * Nivel de esfuerzo con el que corrio la respuesta (`xhigh`, `high`, ...).
   *
   * Sale del campo `effort` de la propia linea `assistant`, asi que es lo que
   * de verdad se uso y no lo que se pidio. null si la linea no lo trae.
   */
  effort: string | null;
  /**
   * Cuanto tardo el turno, en milisegundos.
   *
   * No se calcula restando marcas de tiempo: lo escribe la CLI en una linea
   * `system/turn_duration` que apunta al ultimo mensaje del turno. Medido sobre
   * 50 casos, siempre apunta a un `assistant` y siempre esta en la linea
   * siguiente. null mientras el turno no haya cerrado.
   */
  durationMs: number | null;
  /**
   * true si el mensaje se escribio **mientras el agente ya estaba trabajando**.
   *
   * No es un adorno: cambia lo que el hilo afirma. Un mensaje asi no arranco un
   * turno —lo absorbio uno que ya estaba corriendo— y sin la marca el hilo da a
   * entender que el agente lo leyo, contesto y siguio, cuando lo que paso fue
   * que se lo encontro a mitad de camino.
   *
   * Solo puede ser true en `user`; ver `queued_command` en `jsonl-events.ts`.
   */
  queued: boolean;
}

/**
 * Medidor de contexto.
 *
 * Tokens, nunca dinero: los precios cambian y una cifra desactualizada es peor
 * que ninguna. `cost-state` trae `totalCostUSD` y se ignora a proposito.
 */
export interface ContextUsage {
  /**
   * Lo que ocupo el contexto en la ultima peticion:
   * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
   * Los tres suman lo que el modelo tuvo que leer, esten o no cacheados.
   */
  lastRequestTokens: number;
  lastOutputTokens: number;
  lastModel: string | null;
  /**
   * Tamano de la ventana del modelo, o null si no lo reconocemos.
   * Nunca se inventa un limite: se vio `gpt-5.6-terra` en una sesion
   * importada, con la propia CLI avisando que no lo conocia.
   */
  contextWindow: number | null;
  /**
   * true si `contextWindow` es una **cota inferior deducida**, no un dato.
   *
   * Pasa cuando los tokens medidos superan la ventana que sugiere el nombre del
   * modelo: eso prueba que la ventana real es mayor, pero no dice cuanto. Se
   * marca para que el medidor no presente una deduccion como si fuera un
   * numero publicado.
   */
  contextWindowEstimated: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  /** Cuantas respuestas de asistente entraron en el acumulado. */
  assistantMessages: number;
}

export const EMPTY_CONTEXT_USAGE: ContextUsage = {
  lastRequestTokens: 0,
  lastOutputTokens: 0,
  lastModel: null,
  contextWindow: null,
  contextWindowEstimated: false,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  assistantMessages: 0,
};

/**
 * Estado del seguimiento de un archivo de sesion.
 *
 *  - `waiting`: la ruta esta resuelta pero el archivo todavia no existe. Es lo
 *    normal entre que se abre una pestana y el usuario manda el primer mensaje.
 *  - `live`: se esta siguiendo el archivo.
 *  - `unavailable`: no hay ruta que seguir (por ejemplo, un cwd vacio).
 */
export type ConversationState = 'waiting' | 'live' | 'unavailable';

export const CONVERSATION_STATES: readonly ConversationState[] = [
  'waiting',
  'live',
  'unavailable',
];

// ---------------------------------------------------------------------------
// Ventana de contexto
// ---------------------------------------------------------------------------

/**
 * Tabla corta y explicita de ventanas conocidas.
 *
 * El orden importa: el sufijo `[1m]` gana sobre la familia, porque el mismo
 * modelo existe en las dos variantes. Lo que no matchea devuelve null y el
 * medidor muestra tokens sin barra.
 *
 * OJO, y es la razon de todo lo que sigue en este bloque: **el `model` de las
 * lineas `assistant` NO trae el sufijo de variante.** Dice `claude-opus-5` lo
 * mismo si la sesion corre con 200k que con 1M. Medido sobre el historial de
 * esta instalacion: cero lineas `assistant` con `[1m]`, mientras que las claves
 * de `modelUsage` de las lineas `cost-state` si lo traen
 * (`claude-opus-5[1m]`). Pasar el nombre crudo por esta tabla da 200k siempre,
 * que es exactamente el bug que tenia el medidor.
 */
const CONTEXT_WINDOWS: readonly { readonly pattern: RegExp; readonly tokens: number }[] = [
  { pattern: /\[1m\]/, tokens: 1_000_000 },
  { pattern: /^claude-(opus|sonnet|haiku|fable)-/, tokens: 200_000 },
  { pattern: /^claude-\d/, tokens: 200_000 },
];

/** Ventana del modelo, o null si no lo conocemos. Nunca inventa un limite. */
export function contextWindowFor(model: string | null): number | null {
  if (model === null || model.length === 0) return null;
  for (const entry of CONTEXT_WINDOWS) {
    if (entry.pattern.test(model)) return entry.tokens;
  }
  return null;
}

/**
 * Nombre del modelo sin su sufijo de variante.
 *
 * `claude-opus-5[1m]` -> `claude-opus-5`. Es la clave con la que se casa lo que
 * dice una linea `assistant` (sin sufijo) con lo que dice un `cost-state`
 * (con sufijo).
 */
export function modelVariantBase(model: string): string {
  const bracket = model.indexOf('[');
  return bracket === -1 ? model : model.slice(0, bracket);
}

/**
 * Escalones de ventana conocidos, de menor a mayor.
 *
 * Solo se usan para **subir** un limite que la evidencia ya contradijo. No se
 * inventa un escalon que no exista.
 */
const WINDOW_LADDER: readonly number[] = [200_000, 1_000_000];

/**
 * Sube la ventana si los tokens medidos no entran en ella.
 *
 * Es la ultima red y la unica que no depende de conocer ningun nombre de
 * modelo: si la CLI reporto una peticion de 254k tokens, la ventana **no** es
 * de 200k, y decir lo contrario es dibujar una barra llena mientras la sesion
 * sigue andando. Devuelve tambien si el resultado es una deduccion, para que
 * el medidor lo diga en vez de presentarlo como un dato publicado.
 */
export function fitWindowToObserved(
  window: number | null,
  observedTokens: number,
): { window: number | null; estimated: boolean } {
  if (window === null || observedTokens <= window) {
    return { window, estimated: false };
  }
  const next = WINDOW_LADDER.find((step) => step > observedTokens);
  return next === undefined
    ? // Mas grande que el mayor escalon conocido: el limite real se nos escapa,
      // y decirlo es mejor que dibujar una barra contra un numero inventado.
      { window: null, estimated: false }
    : { window: next, estimated: true };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseMessageUsage(value: unknown): MessageUsage | null {
  const record = asRecord(value);
  if (record === null) return null;

  const inputTokens = asFiniteNumber(record['inputTokens']);
  const outputTokens = asFiniteNumber(record['outputTokens']);
  const cacheCreationInputTokens = asFiniteNumber(record['cacheCreationInputTokens']);
  const cacheReadInputTokens = asFiniteNumber(record['cacheReadInputTokens']);

  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheCreationInputTokens === null ||
    cacheReadInputTokens === null
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
}

function parseQuestionOption(value: unknown): ConversationQuestionOption | null {
  const record = asRecord(value);
  if (record === null) return null;
  const label = asNonEmptyString(record['label']);
  if (label === null) return null;
  return { label, description: asString(record['description']) ?? '' };
}

function parseQuestionItem(value: unknown): ConversationQuestionItem | null {
  const record = asRecord(value);
  if (record === null) return null;
  const question = asNonEmptyString(record['question']);
  const options = asArrayOf(record['options'], parseQuestionOption);
  if (question === null || options === null || options.length === 0) return null;
  return {
    question,
    header: asString(record['header']) ?? '',
    multiSelect: record['multiSelect'] === true,
    options,
  };
}

export function parseConversationPart(value: unknown): ConversationPart | null {
  const record = asRecord(value);
  if (record === null) return null;

  switch (record['kind']) {
    case 'text': {
      const text = asString(record['text']);
      const truncated = asBoolean(record['truncated']);
      return text === null || truncated === null ? null : { kind: 'text', text, truncated };
    }
    case 'tool-call': {
      const toolUseId = asString(record['toolUseId']);
      const name = asString(record['name']);
      const input = asString(record['input']);
      const truncated = asBoolean(record['truncated']);
      return toolUseId === null || name === null || input === null || truncated === null
        ? null
        : { kind: 'tool-call', toolUseId, name, input, truncated };
    }
    case 'tool-result': {
      const toolUseId = asString(record['toolUseId']);
      const text = asString(record['text']);
      const isError = asBoolean(record['isError']);
      const truncated = asBoolean(record['truncated']);
      const imageCount = asFiniteNumber(record['imageCount']);
      return toolUseId === null ||
        text === null ||
        isError === null ||
        truncated === null ||
        imageCount === null
        ? null
        : { kind: 'tool-result', toolUseId, text, isError, truncated, imageCount };
    }
    case 'thinking':
      return { kind: 'thinking' };
    case 'question': {
      const toolUseId = asNonEmptyString(record['toolUseId']);
      const questions = asArrayOf(record['questions'], parseQuestionItem);
      return toolUseId === null || questions === null || questions.length === 0
        ? null
        : { kind: 'question', toolUseId, questions };
    }
    case 'image': {
      const index = asFiniteNumber(record['index']);
      const mediaType = asString(record['mediaType']);
      if (index === null || mediaType === null) return null;
      // `source` puede faltar: es posterior al resto del tipo, y una parte sin
      // el describe una imagen de `message.content`, que es lo que habia antes.
      const source: ConversationImageSource =
        record['source'] === 'attachment' ? 'attachment' : 'content';
      return { kind: 'image', index, mediaType, source };
    }
    default:
      return null;
  }
}

export function parseConversationEvent(value: unknown): ConversationEvent | null {
  const record = asRecord(value);
  if (record === null) return null;

  const eventId = asNonEmptyString(record['eventId']);
  const role = asLiteral(record['role'], CONVERSATION_ROLES);
  const at = asFiniteNumber(record['at']);
  const parts = asArrayOf(record['parts'], parseConversationPart);

  if (eventId === null || role === null || at === null || parts === null) return null;

  return {
    eventId,
    role,
    at,
    parts,
    model: asString(record['model']),
    usage: parseMessageUsage(record['usage']),
    effort: asString(record['effort']),
    durationMs: asFiniteNumber(record['durationMs']),
    queued: record['queued'] === true,
  };
}

export function parseContextUsage(value: unknown): ContextUsage | null {
  const record = asRecord(value);
  if (record === null) return null;

  const lastRequestTokens = asFiniteNumber(record['lastRequestTokens']);
  const lastOutputTokens = asFiniteNumber(record['lastOutputTokens']);
  const totalInputTokens = asFiniteNumber(record['totalInputTokens']);
  const totalOutputTokens = asFiniteNumber(record['totalOutputTokens']);
  const totalCacheReadTokens = asFiniteNumber(record['totalCacheReadTokens']);
  const assistantMessages = asFiniteNumber(record['assistantMessages']);

  if (
    lastRequestTokens === null ||
    lastOutputTokens === null ||
    totalInputTokens === null ||
    totalOutputTokens === null ||
    totalCacheReadTokens === null ||
    assistantMessages === null
  ) {
    return null;
  }

  return {
    lastRequestTokens,
    lastOutputTokens,
    lastModel: asString(record['lastModel']),
    contextWindow: asFiniteNumber(record['contextWindow']),
    contextWindowEstimated: record['contextWindowEstimated'] === true,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    assistantMessages,
  };
}
