/**
 * Todas las sentencias que se corren contra la base de OpenCode.
 *
 * Viven aca, como texto constante, y en ningun otro archivo: asi el chequeo
 * (`check-opencode-db.mjs`, caso 2) puede leerlas todas y comprobar lo que no
 * se nota usando la app.
 *
 * Las reglas, cada una por lo que rompe la contraria:
 *
 *  1. **Nunca `SELECT *`**, y de `data` solo los campos que se dibujan. La base
 *     guarda cosas que la app no tiene por que ver: un `APIError` trae las
 *     cabeceras de la respuesta del proveedor, con `set-cookie`, y un
 *     razonamiento trae su texto entero.
 *  2. **Toda sentencia sobre `message` o `part` filtra por sesion, mensaje o
 *     id.** `node:sqlite` es sincrono: un `json_extract` sobre toda `part`
 *     tarda de 15 a 38 s (medido, 69 634 filas y 1,66 GB), con el servidor
 *     entero parado.
 *  3. **El orden es siempre `time_created, id`.** El campo de tiempo del id dio
 *     la vuelta el 14-08-2026: ordenar por id pone lo nuevo antes que lo viejo.
 *  4. **Todo texto largo se corta en SQL**, con `substr(x, 1, N + 1)` y su
 *     `length`: asi se sabe si hubo recorte sin traer el resto. Un texto llega a
 *     288 891 caracteres y una entrada de herramienta a 86 825.
 *  5. **`$.url` solo en `imageUrlById`**, de a una fila y con tope: una imagen
 *     pegada pesa hasta 1,45 MB de base64.
 *  6. **`$.text` solo de partes de texto**: la de un razonamiento no se lee.
 *
 * Las partes de una carga inicial se piden **por tandas de mensajes**
 * (`partsForMessages`), no paginando `part` por `(time_created, id)`: no hay
 * indice con ese orden, y cada pagina evaluaba y ordenaba todo lo que quedaba
 * de la sesion (medido, la primera pagina de la sesion mas grande costaba casi
 * lo que la consulta entera). La lista de mensajes va como un solo parametro
 * JSON (`json_each`), para que el texto de la sentencia no dependa de cuantos
 * son.
 *
 * Parametros con nombre (`$s`, `$id`, `$max`): se pasan como objeto con la
 * clave tal cual, `{ $s: sessionId }`.
 *
 * **Las dos sentencias de partes van enteras con nombre** (hito 28): sus cortes
 * son parametros (`$textCut`, `$inputCut`, `$outputCut`), porque la copia
 * propia lee la misma sesion con topes mas altos. Se ligan con
 * `partCutParams(limits)`. No se mezclan con `?`: un parametro de corte sin
 * ligar vale NULL, `substr(x, 1, NULL)` da NULL, y la parte llega vacia sin que
 * nada falle.
 */

import { sqlCutLength, type EventLimits } from '../transport-limits.js';
import { toolInputParseMaxChars } from './events.js';

/**
 * Los tres cortes de `PART_COLUMNS` para unos topes, con la clave tal como la
 * nombra la sentencia.
 *
 * La entrada de una herramienta se corta en el tope **de parseo**, no en el de
 * la entrada: se trae entera hasta ahi para poder indentarla, y el recorte a lo
 * que se muestra lo hace `events.ts` sobre el texto ya indentado.
 */
export function partCutParams(limits: EventLimits): { $textCut: number; $inputCut: number; $outputCut: number } {
  return {
    $textCut: sqlCutLength(limits.textMaxChars),
    $inputCut: sqlCutLength(toolInputParseMaxChars(limits)),
    $outputCut: sqlCutLength(limits.toolResultMaxChars),
  };
}

/** Columnas de una parte. Las de herramienta y texto van cortadas (`partCutParams`). */
const PART_COLUMNS = `id, message_id, time_created, time_updated,
  json_extract(data, '$.type') AS type,
  CASE json_extract(data, '$.type') WHEN 'text' THEN substr(json_extract(data, '$.text'), 1, $textCut) END AS text,
  CASE json_extract(data, '$.type') WHEN 'text' THEN length(json_extract(data, '$.text')) END AS text_length,
  json_extract(data, '$.synthetic') AS synthetic,
  json_extract(data, '$.ignored') AS ignored,
  json_extract(data, '$.tool') AS tool,
  json_extract(data, '$.state.status') AS status,
  CASE json_extract(data, '$.type') WHEN 'tool' THEN substr(json_extract(data, '$.state.input'), 1, $inputCut) END AS input_json,
  CASE json_extract(data, '$.type') WHEN 'tool' THEN length(json_extract(data, '$.state.input')) END AS input_length,
  CASE json_extract(data, '$.type') WHEN 'tool' THEN substr(json_extract(data, '$.state.output'), 1, $outputCut) END AS output,
  CASE json_extract(data, '$.type') WHEN 'tool' THEN length(json_extract(data, '$.state.output')) END AS output_length,
  CASE json_extract(data, '$.type') WHEN 'tool' THEN substr(json_extract(data, '$.state.error'), 1, $outputCut) END AS error,
  CASE json_extract(data, '$.type') WHEN 'tool' THEN length(json_extract(data, '$.state.error')) END AS error_length,
  CASE WHEN json_type(data, '$.state.attachments') = 'array' THEN json_array_length(data, '$.state.attachments') END AS attachment_count,
  CASE WHEN json_extract(data, '$.tool') = 'question' THEN json_extract(data, '$.state.metadata.answers') END AS answers_json,
  json_extract(data, '$.mime') AS mime,
  json_extract(data, '$.auto') AS auto`;

export const OPENCODE_SQL = Object.freeze({
  /** Las sesiones que se listan: sin sub-agentes. */
  listRoots: `SELECT id, directory, title, time_created, time_updated
FROM session WHERE parent_id IS NULL
ORDER BY time_created, id`,

  /** La foto con la que se decide que sesiones cambiaron. */
  rootStamps: `SELECT id, time_updated FROM session WHERE parent_id IS NULL`,

  sessionById: `SELECT id, parent_id, directory, title, time_created, time_updated, revert
FROM session WHERE id = ?`,

  sessionExists: `SELECT 1 AS found FROM session WHERE id = ?`,

  /** Si la sesion tiene al menos un mensaje. Solo toca el indice. */
  sessionHasMessages: `SELECT 1 AS found FROM message WHERE session_id = ? LIMIT 1`,

  /** El primer texto que escribio el usuario, sin los que agrega la CLI. */
  firstUserText: `SELECT substr(json_extract(p.data, '$.text'), 1, 400) AS text
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id = ?
  AND json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.type') = 'text'
  AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
  AND coalesce(json_extract(p.data, '$.ignored'), 0) = 0
  AND length(trim(json_extract(p.data, '$.text'))) > 0
ORDER BY m.time_created, m.id, p.time_created, p.id
LIMIT 1`,

  /** Conteos y maximos: si no cambiaron, no hay nada que releer. */
  sessionSignature: `SELECT (SELECT count(*) FROM message WHERE session_id = $s) AS message_count,
  (SELECT coalesce(max(time_updated), 0) FROM message WHERE session_id = $s) AS message_max,
  (SELECT count(*) FROM part WHERE session_id = $s) AS part_count,
  (SELECT coalesce(max(time_updated), 0) FROM part WHERE session_id = $s) AS part_max`,

  messagesSince: `SELECT id, time_created, time_updated,
  json_extract(data, '$.role') AS role,
  json_extract(data, '$.parentID') AS parent_id,
  json_extract(data, '$.providerID') AS provider_id,
  json_extract(data, '$.modelID') AS model_id,
  json_extract(data, '$.variant') AS variant,
  json_extract(data, '$.summary') AS summary,
  json_extract(data, '$.finish') AS finish,
  json_extract(data, '$.time.created') AS created_at,
  json_extract(data, '$.time.completed') AS completed_at,
  json_extract(data, '$.tokens.input') AS t_input,
  json_extract(data, '$.tokens.output') AS t_output,
  json_extract(data, '$.tokens.reasoning') AS t_reasoning,
  json_extract(data, '$.tokens.cache.read') AS t_cache_read,
  json_extract(data, '$.tokens.cache.write') AS t_cache_write,
  json_extract(data, '$.error.name') AS error_name,
  substr(json_extract(data, '$.error.data.message'), 1, 300) AS error_message
FROM message WHERE session_id = ? AND time_updated >= ?
ORDER BY time_created, id`,

  /** Cuantas partes tiene cada mensaje: arma las tandas de la carga inicial. Solo toca el indice. */
  partCountsByMessage: `SELECT message_id, count(*) AS part_count
FROM part WHERE session_id = ? GROUP BY message_id`,

  /** Las partes de una tanda de mensajes. `$ids`: un arreglo JSON de ids; mas `partCutParams`. */
  partsForMessages: `SELECT ${PART_COLUMNS}
FROM part WHERE message_id IN (SELECT value FROM json_each($ids))
ORDER BY time_created, id`,

  /** Lo que cambio desde un momento, para las lecturas incrementales. `$s`, `$since` y `partCutParams`. */
  partsSince: `SELECT ${PART_COLUMNS}
FROM part WHERE session_id = $s AND time_updated >= $since
ORDER BY time_created, id`,

  imageParts: `SELECT id, json_extract(data, '$.mime') AS mime
FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'file'
ORDER BY time_created, id`,

  /** El unico que lee `$.url`. `$max`: el tope en caracteres; por encima, null. */
  imageUrlById: `SELECT CASE WHEN length(json_extract(data, '$.url')) <= $max THEN json_extract(data, '$.url') END AS url
FROM part WHERE id = $id AND json_extract(data, '$.type') = 'file'`,

  /** Sesiones raiz nacidas desde un momento: con esto se casa una pestana nueva. */
  discoveryRows: `SELECT id, directory, time_created FROM session
WHERE parent_id IS NULL AND time_created >= ?
ORDER BY time_created, id`,
});

export type OpenCodeStatement = keyof typeof OPENCODE_SQL;

/**
 * Columnas que tienen que estar para leer la base. Si falta una, no se lee nada
 * (`ReadOnlyDatabase`, estado `schema`).
 */
export const OPENCODE_REQUIRED_COLUMNS = Object.freeze([
  { table: 'session', columns: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated', 'revert'] },
  { table: 'message', columns: ['id', 'session_id', 'time_created', 'time_updated', 'data'] },
  { table: 'part', columns: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'] },
] as const);

// ---- Filas ------------------------------------------------------------------
// Un booleano de JSON sale de `json_extract` como 1 o 0, y un objeto o arreglo
// como su texto JSON.

export interface RootRow {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

export interface RootStampRow {
  id: string;
  time_updated: number;
}

export interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
  /** JSON crudo, o null. */
  revert: string | null;
}

export interface FoundRow {
  found: number;
}

export interface FirstUserTextRow {
  text: string | null;
}

export interface SignatureRow {
  message_count: number;
  message_max: number;
  part_count: number;
  part_max: number;
}

export interface MessageRow {
  id: string;
  time_created: number;
  time_updated: number;
  role: string | null;
  parent_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  variant: string | null;
  summary: number | null;
  finish: string | null;
  created_at: number | null;
  completed_at: number | null;
  t_input: number | null;
  t_output: number | null;
  t_reasoning: number | null;
  t_cache_read: number | null;
  t_cache_write: number | null;
  error_name: string | null;
  /** Ya cortado a 300 caracteres. */
  error_message: string | null;
}

export interface PartCountRow {
  message_id: string;
  part_count: number;
}

export interface PartRow {
  id: string;
  message_id: string;
  time_created: number;
  time_updated: number;
  type: string | null;
  /** Cortado a `$textCut` (8001 en el hilo): si `text_length` pasa del tope, hubo recorte. */
  text: string | null;
  text_length: number | null;
  synthetic: number | null;
  ignored: number | null;
  tool: string | null;
  status: string | null;
  /** JSON, cortado a `$inputCut` (16 001 en el hilo). */
  input_json: string | null;
  input_length: number | null;
  output: string | null;
  output_length: number | null;
  error: string | null;
  error_length: number | null;
  attachment_count: number | null;
  /** JSON (arreglo de arreglos de texto), solo en `question`. */
  answers_json: string | null;
  mime: string | null;
  auto: number | null;
}

export interface ImagePartRow {
  id: string;
  mime: string | null;
}

export interface ImageUrlRow {
  url: string | null;
}

export interface DiscoveryRow {
  id: string;
  directory: string;
  time_created: number;
}
