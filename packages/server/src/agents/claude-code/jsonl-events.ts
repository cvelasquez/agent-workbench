/**
 * Traduce una linea del JSONL a un evento de conversacion.
 *
 * Reglas que salen de haber medido las 230 sesiones de esta instalacion:
 *
 *  - **Desconocido = se ignora en silencio.** Hay 17 tipos de linea distintos y
 *    cambian entre versiones de la CLI (`file-history-delta` no estaba
 *    documentado y aparece 44 veces). Producen eventos `user`, `assistant` y
 *    —solo en un caso muy acotado— `attachment`; todo lo demas devuelve null
 *    sin lanzar.
 *  - **Todo se recorta.** Una linea puede pesar 290 KB. El panel es un resumen
 *    navegable, no un visor de adjuntos.
 *  - **Las imagenes no viajan.** Se cuentan y se descartan: son base64 de
 *    cientos de KB.
 */

import type {
  ConversationEvent,
  ConversationPart,
  ConversationQuestionItem,
  ConversationQuestionOption,
  ConversationRole,
  MessageUsage,
} from '@agent-workbench/shared';

/** Texto de un mensaje. Alcanza para leer la respuesta sin traer un libro. */
const TEXT_MAX_CHARS = 8_000;
/** Entrada de una herramienta. Un Write completo no aporta en el panel. */
const TOOL_INPUT_MAX_CHARS = 2_000;
/** Resultado de una herramienta. Van colapsados por defecto. */
const TOOL_RESULT_MAX_CHARS = 4_000;

interface Truncated {
  text: string;
  truncated: boolean;
}

function cut(raw: string, limit: number): Truncated {
  if (raw.length <= limit) return { text: raw, truncated: false };
  return { text: raw.slice(0, limit), truncated: true };
}

/**
 * Envoltorios que escribe la CLI cuando el usuario le da una orden **a ella**.
 *
 * Un `/model`, un `/effort`, un `!git status`: la CLI los anota en el
 * transcript con estas etiquetas, y el modelo nunca los vio. Inventario de
 * esta instalacion, contando solo los mensajes que empiezan con la etiqueta:
 * `command-name` 21, `local-command-stdout` 21, `local-command-caveat` 20,
 * `bash-input` y `bash-stdout` 1 cada uno.
 *
 * `system-reminder` va aparte porque no es una orden sino contexto que
 * inyecta el arnes, pero se descarta por lo mismo: no lo escribio nadie.
 */
const HARNESS_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
];

const HARNESS_BLOCK = new RegExp(`<(${HARNESS_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');

/**
 * Saca del texto del usuario lo que inyecta el arnes y no escribio nadie.
 *
 * **Los comandos se quitan enteros, no se desenvuelven.** Hasta el hito 15 se
 * conservaba el nombre del comando —`/model` quedaba escrito en el hilo— y el
 * resultado eran cuatro tarjetas seguidas diciendo `/model`, `opus[1m]`,
 * `Set model to...`, `/effort`, en medio de la conversacion. Es ruido de la
 * herramienta, no del trabajo: eso se ve en la solapa CLI, que es donde el
 * comando se ejecuto. Un mensaje que era solo eso queda vacio y no genera
 * tarjeta, que es lo que hace el llamador con cualquier texto vacio.
 *
 * Sigue siendo quirurgica y no una purga de etiquetas: se quitan estos
 * envoltorios y nada mas. Un usuario que pega HTML tiene que ver su HTML, y
 * por eso lo que sobreviva al filtro se muestra igual — un mensaje con un
 * comando **y** texto propio conserva el texto propio.
 */
function cleanUserText(raw: string): string {
  return raw.replace(HARNESS_BLOCK, '').trim();
}

/** `message.usage`, con los nombres del JSONL pasados a los nuestros. */
function readUsage(value: unknown): MessageUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const read = (key: string): number => {
    const raw = record[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };

  const usage: MessageUsage = {
    inputTokens: read('input_tokens'),
    outputTokens: read('output_tokens'),
    cacheCreationInputTokens: read('cache_creation_input_tokens'),
    cacheReadInputTokens: read('cache_read_input_tokens'),
  };

  // Un usage con todo en cero no es un usage: es una linea que no lo traia.
  const total =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return total > 0 ? usage : null;
}

/**
 * Aplana el contenido de un `tool_result`.
 *
 * Puede ser un string (382 casos) o un array de bloques (72), y adentro del
 * array hay `text`, `image` y `tool_reference`.
 */
function flattenToolResultContent(content: unknown): { text: string; imageCount: number } {
  if (typeof content === 'string') return { text: content, imageCount: 0 };
  if (!Array.isArray(content)) return { text: '', imageCount: 0 };

  const parts: string[] = [];
  let imageCount = 0;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'image') {
      imageCount += 1;
      continue;
    }
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text']);
    }
    // `tool_reference` y cualquier otro tipo se ignoran: no son contenido.
  }

  return { text: parts.join('\n'), imageCount };
}

/**
 * La herramienta con la que la CLI hace preguntas de eleccion.
 *
 * Se compara por nombre y es lo unico que se trata distinto: no hay una marca
 * en la linea que diga "esto espera una respuesta". Si la CLI la renombra,
 * la tarjeta vuelve a ser la generica y nada se rompe.
 */
const ASK_TOOL_NAME = 'AskUserQuestion';

/** Tope de texto por pregunta y por opcion. Una tarjeta, no un documento. */
const QUESTION_MAX_CHARS = 400;

function readQuestionOption(value: unknown): ConversationQuestionOption | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const label = record['label'];
  if (typeof label !== 'string' || label.length === 0) return null;
  const description = record['description'];
  return {
    label: cut(label, QUESTION_MAX_CHARS).text,
    description:
      typeof description === 'string' ? cut(description, QUESTION_MAX_CHARS).text : '',
  };
}

/**
 * Las preguntas del input de `AskUserQuestion`, o null si no tienen esa forma.
 *
 * **El orden de `options` no es cosmetico: es la respuesta.** La CLI numera las
 * opciones en pantalla siguiendo este array, y el numero es lo que se le manda
 * a la pty para elegir (ver `buildAnswerKeys` en `pty-input.ts`). Reordenarlas
 * en cualquier punto del camino elige otra cosa.
 */
function readQuestions(value: unknown): ConversationQuestionItem[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)['questions'];
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const questions: ConversationQuestionItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const question = record['question'];
    if (typeof question !== 'string' || question.length === 0) return null;
    if (!Array.isArray(record['options']) || record['options'].length === 0) return null;

    const options: ConversationQuestionOption[] = [];
    for (const option of record['options']) {
      const parsed = readQuestionOption(option);
      // Una opcion que no se entiende desplaza a todas las que le siguen, y
      // con ellas el numero que las elige. Se descarta la pregunta entera.
      if (parsed === null) return null;
      options.push(parsed);
    }

    const header = record['header'];
    questions.push({
      question: cut(question, QUESTION_MAX_CHARS).text,
      header: typeof header === 'string' ? cut(header, QUESTION_MAX_CHARS).text : '',
      multiSelect: record['multiSelect'] === true,
      options,
    });
  }
  return questions;
}

function toPart(
  block: unknown,
  role: ConversationRole,
  index: number,
): ConversationPart | null {
  if (typeof block !== 'object' || block === null) return null;
  const record = block as Record<string, unknown>;

  switch (record['type']) {
    case 'text': {
      const raw = record['text'];
      if (typeof raw !== 'string') return null;
      const cleaned = role === 'user' ? cleanUserText(raw) : raw;
      if (cleaned.length === 0) return null;
      const { text, truncated } = cut(cleaned, TEXT_MAX_CHARS);
      return { kind: 'text', text, truncated };
    }

    // El contenido del razonamiento no esta en el JSONL: solo la firma. Se deja
    // la marca de que hubo, sin prometer un texto que no existe.
    case 'thinking':
    case 'redacted_thinking':
      return { kind: 'thinking' };

    case 'tool_use': {
      const toolUseId = record['id'];
      const name = record['name'];
      if (typeof toolUseId !== 'string' || typeof name !== 'string') return null;

      // Una pregunta de eleccion se estructura aca, donde el input esta
      // entero: el recorte de abajo la partiria a la mitad y el navegador no
      // podria parsearla. Si no tiene la forma esperada cae a la tarjeta
      // generica, que muestra exactamente lo que mostraba antes.
      if (name === ASK_TOOL_NAME) {
        const questions = readQuestions(record['input']);
        if (questions !== null) return { kind: 'question', toolUseId, questions };
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(record['input'], null, 2) ?? '';
      } catch {
        // Entradas con referencias circulares no deberian existir, pero una
        // tarjeta sin entrada es mejor que un evento perdido.
        serialized = '';
      }
      const { text, truncated } = cut(serialized, TOOL_INPUT_MAX_CHARS);
      return { kind: 'tool-call', toolUseId, name, input: text, truncated };
    }

    /*
      Una imagen del usuario. Viaja la referencia, nunca los bytes: el bloque
      trae base64 de cientos de KB y esto se manda con cada evento. El contenido
      se pide aparte, y solo si alguien mira la miniatura.

      Esta es la que deja `Alt+V` en la solapa CLI. La otra forma —la que usa el
      cuadro de escritura— no es un bloque sino una linea aparte, y sale por
      `toUserImageAttachment`.
    */
    case 'image': {
      const source = record['source'];
      if (typeof source !== 'object' || source === null) return null;
      const mediaType = (source as Record<string, unknown>)['media_type'];
      return {
        kind: 'image',
        index,
        mediaType: typeof mediaType === 'string' ? mediaType : 'image/png',
        source: 'content',
      };
    }

    case 'tool_result': {
      const toolUseId = record['tool_use_id'];
      if (typeof toolUseId !== 'string') return null;
      const flat = flattenToolResultContent(record['content']);
      const { text, truncated } = cut(flat.text, TOOL_RESULT_MAX_CHARS);
      return {
        kind: 'tool-result',
        toolUseId,
        text,
        isError: record['is_error'] === true,
        truncated,
        imageCount: flat.imageCount,
      };
    }

    default:
      return null;
  }
}

/** Epoch ms del `timestamp` ISO, o 0 si la linea no lo trae. */
function readTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Un mensaje escrito mientras el agente ya estaba trabajando.
 *
 * **No es una linea `user`, y por eso no se veia.** Lo que la CLI escribe
 * cuando uno teclea con el agente en marcha son tres lineas distintas, medidas
 * sobre el archivo real donde el usuario reporto el bug:
 *
 * ```
 * 409 queue-operation  {"operation":"enqueue","content":"Ya esta activa la vpn…"}
 * 411 queue-operation  {"operation":"remove","reason":"absorbed_mid_turn",…}
 * 413 attachment       {"attachment":{"type":"queued_command","prompt":"Ya esta…",
 *                       "commandMode":"prompt","origin":{"kind":"human"}}}
 * ```
 *
 * De las tres se dibuja **esta**, y el conteo de la instalacion dice por que:
 * 69 `enqueue`, 39 `dequeue`, 26 `absorbed_mid_turn` y **26**
 * `queued_command`. Los 39 que salen por `dequeue` arrancan un turno propio y
 * ya llegan como linea `user` normal; dibujar tambien su `enqueue` los
 * mostraria dos veces. Los absorbidos a mitad de turno son exactamente los que
 * hoy no se ven, y son exactamente los que dejan un `queued_command`.
 *
 * Va en la posicion del archivo, que es donde el agente lo vio, no donde se
 * tecleo. Es lo mismo que hace la CLI en su propia pantalla.
 *
 * **El filtro es por `commandMode`**, no por `origin`: de los 26, veinte son
 * `task-notification` —avisos que se manda el propio agente— y seis son
 * `prompt` con `origin.kind: "human"`. `commandMode` es el que separa las dos
 * cosas; `origin` se comprueba solo si viene, para que una version futura que
 * lo deje de escribir no haga desaparecer el mensaje otra vez.
 */
function toQueuedUserEvent(
  record: Record<string, unknown>,
  lineNumber: number,
): ConversationEvent | null {
  const attachment = record['attachment'];
  if (typeof attachment !== 'object' || attachment === null) return null;
  const attachmentRecord = attachment as Record<string, unknown>;
  if (attachmentRecord['type'] !== 'queued_command') return null;
  if (attachmentRecord['commandMode'] !== 'prompt') return null;

  const origin = attachmentRecord['origin'];
  if (typeof origin === 'object' && origin !== null) {
    if ((origin as Record<string, unknown>)['kind'] !== 'human') return null;
  }

  const prompt = attachmentRecord['prompt'];
  if (typeof prompt !== 'string') return null;
  const cleaned = cleanUserText(prompt);
  if (cleaned.length === 0) return null;

  const { text, truncated } = cut(cleaned, TEXT_MAX_CHARS);
  const uuid = record['uuid'];

  return {
    eventId: typeof uuid === 'string' && uuid.length > 0 ? uuid : `line-${lineNumber}`,
    role: 'user',
    // El `timestamp` de la linea es el de cuando se escribio, no el de cuando
    // se absorbio. Es el que corresponde: es cuando el usuario lo mando.
    at: readTimestamp(record['timestamp'] ?? attachmentRecord['timestamp']),
    parts: [{ kind: 'text', text, truncated }],
    model: null,
    usage: null,
    effort: null,
    durationMs: null,
    queued: true,
  };
}

// ---------------------------------------------------------------------------
// La otra forma de las imagenes del usuario
// ---------------------------------------------------------------------------

/**
 * Una imagen que la CLI adjunto por ruta, y que vive en su **propia linea**.
 *
 * Es lo que deja el cuadro de escritura. Al mandar una imagen no se le pasan
 * los bytes a la CLI: se le nombra la ruta del archivo (§5.3,
 * `fileReference`), y la CLI la lee y la adjunta ella. Lo que escribe en el
 * JSONL son dos lineas y no una:
 *
 * ```
 * 6  user        {"message":{"content":"@\"C:\\…\\pegada-2.png\" compartir…"}}
 * 7  attachment  {"parentUuid":"6c33dd3f-…","attachment":{"type":"file",
 *                 "filename":"C:\\…\\pegada-2.png",
 *                 "content":{"type":"image","file":{"base64":"iVBORw0…",
 *                 "type":"image/png"}}}}
 * ```
 *
 * **Con dos imagenes, la segunda cuelga de la primera.** Es lo que rompia la
 * miniatura de la segunda, y no se ve hasta que se miran los `parentUuid`
 * seguidos:
 *
 * ```
 * 1323 user        uuid=06511bc8   @"…pegada-6.png" @"…pegada-7.png" pero yo…
 * 1324 attachment  parent=06511bc8  uuid=e7e2efda   pegada-6.png
 * 1325 attachment  parent=e7e2efda  <- el adjunto anterior   pegada-7.png
 * ```
 *
 * Remedido sobre los 39 adjuntos de imagen de la instalacion: 34 cuelgan de una
 * linea `user` y **5 de otro adjunto**, y los 39 estan a una linea de su padre.
 * La distancia igual no se usa —se sigue el `parentUuid`, que es el unico dato
 * que lo dice de verdad— asi que quien aplica el adjunto tiene que saber
 * recorrer la cadena hasta el mensaje. De ahi `attachmentId`.
 *
 * Sin bytes, igual que la otra forma: viaja la referencia y el contenido se
 * pide aparte (`loadConversationImage`).
 */
export interface UserImageAttachment {
  /** `uuid` de la propia linea, que es de quien puede colgar la siguiente. */
  attachmentId: string;
  /** `uuid` del mensaje **o del adjunto anterior** del que cuelga. */
  eventId: string;
  mediaType: string;
  /**
   * La ruta con la que la CLI la adjunto.
   *
   * Es lo que se busca en el texto del mensaje para sacarlo de ahi: sin esto,
   * el hilo muestra un `@"C:\Users\…\pegada-2-7b3a5273.png"` de sesenta
   * caracteres donde deberia haber una miniatura.
   */
  filename: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Lee una linea `attachment` de imagen, o null si no lo es.
 *
 * Se exige el `base64`: sin bytes no hay miniatura que dibujar, y una
 * referencia que no se puede resolver deja un "cargando imagen…" para siempre.
 * Cualquier otra forma devuelve null y la linea se sigue ignorando como hasta
 * ahora — desconocido no rompe (§4.4).
 */
export function toUserImageAttachment(
  record: Record<string, unknown>,
): UserImageAttachment | null {
  if (record['type'] !== 'attachment') return null;
  if (record['isSidechain'] === true) return null;

  const attachment = recordOf(record['attachment']);
  if (attachment === null || attachment['type'] !== 'file') return null;

  const content = recordOf(attachment['content']);
  if (content === null || content['type'] !== 'image') return null;

  const file = recordOf(content['file']);
  if (file === null) return null;
  const base64 = file['base64'];
  if (typeof base64 !== 'string' || base64.length === 0) return null;

  const eventId = record['parentUuid'];
  if (typeof eventId !== 'string' || eventId.length === 0) return null;

  const attachmentId = record['uuid'];
  const mediaType = file['type'];
  const filename = attachment['filename'] ?? attachment['displayPath'];

  return {
    attachmentId: typeof attachmentId === 'string' ? attachmentId : '',
    eventId,
    mediaType: typeof mediaType === 'string' && mediaType.length > 0 ? mediaType : 'image/png',
    filename: typeof filename === 'string' ? filename : '',
  };
}

/** Una ruta comparable: los separadores dan igual, y Windows no distingue caja. */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function baseNameOf(value: string): string {
  const slash = value.lastIndexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}

/**
 * Saca del texto la referencia `@ruta` que nombra a un adjunto ya resuelto.
 *
 * **Se quita el envoltorio, no el mensaje** (§4.12). Solo se borra el token que
 * nombra a *este* adjunto; si no hay ninguno que case, el texto sale intacto.
 * Un `@"foto.png"` que la CLI no llego a adjuntar se sigue viendo, que es lo
 * correcto: ahi no hay miniatura que lo reemplace.
 *
 * La comparacion es tolerante porque el `filename` del adjunto viene
 * normalizado por la CLI y lo tecleado no. Medido sobre los 17 adjuntos de la
 * instalacion: 14 casan literal, y los 3 que no son rutas escritas a mano con
 * `/` o relativas (`@red.png`). Por eso hay dos vueltas — ruta completa y, si
 * no, nombre de archivo—: lo que manda esta app siempre cae en la primera.
 */
export function stripFileReference(text: string, filename: string): string {
  if (filename.length === 0) return text;

  const target = normalizePath(filename);
  const targetBase = baseNameOf(target);

  // `@"con espacios"` o `@sin-espacios`, y siempre al principio o tras un
  // blanco: sin eso, el `@` de un correo entraria en el reparto.
  const tokens = /(^|\s)@(?:"([^"]*)"|(\S+))/g;

  for (const round of [0, 1]) {
    tokens.lastIndex = 0;
    let match = tokens.exec(text);
    while (match !== null) {
      const raw = match[2] ?? match[3] ?? '';
      const candidate = normalizePath(raw);
      const hit = round === 0 ? candidate === target : baseNameOf(candidate) === targetBase;
      if (hit && raw.length > 0) {
        const lead = match[1] ?? '';
        const start = match.index + lead.length;
        const end = match.index + match[0].length;
        const before = text.slice(0, start);
        // El hueco no puede dejar dos blancos pegados donde habia uno.
        const after = /[ \t]$/.test(before) ? text.slice(end).replace(/^[ \t]/, '') : text.slice(end);
        return `${before}${after}`.trim();
      }
      match = tokens.exec(text);
    }
  }
  return text;
}

/**
 * Una linea ya parseada a objeto -> evento, o null si no corresponde mostrarla.
 *
 * `lineNumber` solo se usa para fabricar un id cuando la linea no trae `uuid`.
 */
export function toConversationEvent(
  record: Record<string, unknown>,
  lineNumber: number,
): ConversationEvent | null {
  const type = record['type'];

  // Ruido interno del arnes: no lo escribio ni el usuario ni el modelo.
  if (record['isMeta'] === true) return null;
  if (record['isVisibleInTranscriptOnly'] === true) return null;
  // Las ramas de subagente son otra conversacion; mezclarlas confunde el hilo.
  if (record['isSidechain'] === true) return null;

  // El unico `attachment` que es un mensaje de alguien. El resto son avisos
  // del arnes y siguen ignorandose en silencio (§4.4).
  if (type === 'attachment') return toQueuedUserEvent(record, lineNumber);

  if (type !== 'user' && type !== 'assistant') return null;

  const message = record['message'];
  if (typeof message !== 'object' || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const role: ConversationRole = type;
  const content = messageRecord['content'];

  const parts: ConversationPart[] = [];
  if (typeof content === 'string') {
    const cleaned = role === 'user' ? cleanUserText(content) : content;
    if (cleaned.length > 0) {
      const { text, truncated } = cut(cleaned, TEXT_MAX_CHARS);
      parts.push({ kind: 'text', text, truncated });
    }
  } else if (Array.isArray(content)) {
    content.forEach((block, index) => {
      const part = toPart(block, role, index);
      if (part !== null) parts.push(part);
    });
  }

  // Un mensaje que quedo sin nada visible no genera tarjeta.
  if (parts.length === 0) return null;

  const uuid = record['uuid'];
  const model = messageRecord['model'];
  // `effort` vive en la raiz de la linea, no dentro de `message`.
  const effort = record['effort'];

  return {
    eventId: typeof uuid === 'string' && uuid.length > 0 ? uuid : `line-${lineNumber}`,
    role,
    at: readTimestamp(record['timestamp']),
    parts,
    model: typeof model === 'string' ? model : null,
    usage: readUsage(messageRecord['usage']),
    effort: typeof effort === 'string' && effort.length > 0 ? effort : null,
    // Lo completa la linea `system/turn_duration` que viene despues.
    durationMs: null,
    // Un mensaje que llego como linea `user` arranco su propio turno.
    queued: false,
  };
}

/**
 * El nombre del archivo de un plan que esta linea nombra, o null.
 *
 * La CLI escribe los planes del modo plan en `~/.claude/plans/<slug>.md` y los
 * anuncia de **dos** formas distintas. Medido sobre los archivos de esta
 * instalacion, y las dos hacen falta:
 *
 *  1. Una linea `attachment` con `plan_mode` o `plan_mode_exit`, que trae
 *     `planFilePath`. Ocho casos, los ocho con la ruta:
 *
 *     ```
 *     {"type":"attachment","attachment":{"type":"plan_mode",
 *       "planFilePath":"C:\\Users\\…\\.claude\\plans\\virtual-chasing-peacock.md",
 *       "planExists":false}}
 *     ```
 *
 *  2. Un `tool_use` de `Write` a esa misma carpeta. Es lo que hizo la sesion
 *     que motivo este panel: **no** tiene ninguna linea `plan_mode`, y mirando
 *     solo la primera forma se habria quedado afuera justo el caso del pedido.
 *
 * Devuelve el **nombre del archivo**, no la ruta: la carpeta la pone el
 * servidor (`plansRoot()`), igual que con cualquier otra ruta que toca la app
 * (CLAUDE.md 2.4). Una ruta de plan que apunte a otro lado no es un plan de la
 * CLI y no se mira.
 */
export function toPlanFileName(record: Record<string, unknown>): string | null {
  const attachment = recordOf(record['attachment']);
  if (attachment !== null) {
    const type = attachment['type'];
    if (type === 'plan_mode' || type === 'plan_mode_exit') {
      return planFileNameOf(attachment['planFilePath']);
    }
  }

  if (record['type'] !== 'assistant') return null;
  const message = recordOf(record['message']);
  if (message === null) return null;
  const content = message['content'];
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    const blockRecord = recordOf(block);
    if (blockRecord === null || blockRecord['type'] !== 'tool_use') continue;
    if (blockRecord['name'] !== 'Write') continue;
    const input = recordOf(blockRecord['input']);
    if (input === null) continue;
    const name = planFileNameOf(input['file_path']);
    if (name !== null) return name;
  }

  return null;
}

/**
 * El nombre del archivo, si la ruta esta dentro de la carpeta de planes.
 *
 * Se compara el tramo `.claude/plans/` y se acepta un solo segmento detras:
 * cualquier otra cosa —un `..`, una subcarpeta, una ruta de otro lado— no es un
 * plan de la CLI y devuelve null. La comparacion tolera los dos separadores
 * porque el JSONL de Windows trae `\\` y el de macOS `/`.
 */
function planFileNameOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replace(/\\/g, '/');
  const marker = '/.claude/plans/';
  const at = normalized.toLowerCase().lastIndexOf(marker);
  if (at === -1) return null;

  const name = normalized.slice(at + marker.length);
  if (name.length === 0 || name.includes('/')) return null;
  if (name === '.' || name === '..') return null;
  return name;
}

/**
 * Cuanto duro un turno, si la linea lo dice.
 *
 * La CLI escribe `{"type":"system","subtype":"turn_duration","durationMs":...}`
 * con `parentUuid` apuntando al ultimo mensaje del turno. Medido sobre 50
 * casos de esta instalacion: **siempre** apunta a un `assistant` y **siempre**
 * esta en la linea inmediatamente siguiente.
 *
 * Se lee de ahi y no se calcula restando marcas de tiempo: la resta entre el
 * mensaje del usuario y la respuesta incluye el rato que el usuario tardo en
 * mandar el siguiente, y da numeros que no significan nada.
 */
export function toTurnDuration(
  record: Record<string, unknown>,
): { eventId: string; durationMs: number } | null {
  if (record['type'] !== 'system' || record['subtype'] !== 'turn_duration') return null;
  const eventId = record['parentUuid'];
  const durationMs = record['durationMs'];
  if (typeof eventId !== 'string' || eventId.length === 0) return null;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return { eventId, durationMs };
}
