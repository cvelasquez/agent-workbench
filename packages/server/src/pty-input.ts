/**
 * Como se le escribe a la pty desde fuera del teclado.
 *
 * Todo lo que manda el cuadro de escritura pasa por aca. Es el unico lugar del
 * proyecto que sabe de secuencias de escape, y esta separado justamente para
 * que nadie mas las escriba a mano.
 *
 * ---
 *
 * **El texto va dentro de un pegado, no tecleado.** `ESC[200~ … ESC[201~` es el
 * *bracketed paste* de toda la vida, y la CLI lo activa al arrancar (declara
 * `ESC[?2004h`). Que sea un pegado y no una escritura cambia dos cosas, las dos
 * medidas contra la CLI 2.1.257 y las dos imprescindibles:
 *
 *  1. **Los saltos de linea son texto.** Un `\n` suelto tecleado envia el
 *     mensaje; dentro del pegado se queda como salto. Es lo que hace posible
 *     que `Shift+Enter` exista.
 *  2. **`@` no abre el autocompletado.** Tecleado caracter por caracter, `@red`
 *     despliega el selector de archivos del TUI y las teclas siguientes navegan
 *     ese menu en vez de escribir. Pegado, entra como texto plano. Verificado
 *     con las dos formas sobre la misma sesion.
 *
 * El `\r` que envia va **fuera** del pegado, despues del cierre. Con Claude
 * Code se escribe todo junto en un solo write: la pty es un flujo ordenado de
 * bytes y la CLI lo procesa en orden, asi que no hay carrera que sincronizar —
 * comprobado mandando tres lineas y un Enter en la misma llamada.
 *
 * No toda CLI lo consume asi. Por eso un envio se arma en **piezas**
 * (`buildSubmissionWrites`) y es cada adaptador el que declara cuantas y con
 * que separacion (`AgentInput` en `agents/adapter.ts`).
 */

import { cycleDistance, type ImageReferenceStyle } from '@agent-workbench/shared';

/** DECSET 2004. La CLI lo activa sola al arrancar. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Shift+Tab. Cicla el modo de permiso de la CLI.
 *
 * Es `CSI Z` —el "tab hacia atras" de toda la vida—, no una secuencia propia
 * de la CLI. Verificado contra la 2.1.260: cada pulsacion mueve un lugar en el
 * ciclo `auto -> default -> acceptEdits -> plan`.
 */
const SHIFT_TAB = '\x1b[Z';

/** Lo que envia el mensaje. `\r`, no `\n`: es lo que manda una terminal. */
const SUBMIT = '\r';

/** Esc. Interrumpe lo que la CLI este haciendo. */
export const INTERRUPT = '\x1b';

/**
 * Tope de lo que se acepta en un envio.
 *
 * No es un limite de la CLI —pega archivos enteros sin quejarse— sino una
 * defensa: el mensaje llega por el socket y termina en el stdin de un proceso.
 */
export const MAX_SUBMIT_CHARS = 200_000;

/**
 * Deja el texto en condiciones de viajar dentro de un pegado.
 *
 * El orden de los reemplazos importa y no es cosmetico:
 *
 *  - Primero se quitan los delimitadores de pegado que pudiera traer el texto.
 *    Si no, un usuario que pega la cadena `ESC[201~` cierra el pegado a mitad y
 *    el resto de su propio texto se interpreta como teclas.
 *  - Despues los CRLF, porque un `\r` suelto adentro del pegado **envia**: el
 *    mensaje saldria partido en pedazos, uno por linea.
 *  - Al final el resto de los caracteres de control, que en una terminal no son
 *    texto sino ordenes. Se conservan `\n` y `\t`, que si lo son.
 */
export function sanitizeForPaste(text: string): string {
  return text
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Referencia a un archivo para que la CLI lo adjunte.
 *
 * Las comillas no son opcionales: sin ellas, una ruta con espacios
 * —`C:\Users\Jane Doe\...`, que es de lo mas comun en Windows— se corta en el
 * primer espacio. Verificado que `@"<ruta con espacios>"` adjunta bien.
 *
 * La forma la declara cada CLI (`imagesByPath`). Hoy hay una sola, y por eso el
 * estilo tiene valor por omision.
 */
export function fileReference(
  absolutePath: string,
  style: ImageReferenceStyle = 'at-quoted',
): string {
  /*
    El respaldo no es decorativo: `rutas.map(fileReference)` le pasa el indice
    como segundo argumento, y sin esto cada ruta saldria como `undefined`.
  */
  const build = IMAGE_REFERENCE_BUILDERS[style] ?? IMAGE_REFERENCE_BUILDERS['at-quoted'];
  return build(absolutePath);
}

/** Una entrada por estilo: agregar uno a `ImageReferenceStyle` sin su forma no compila. */
const IMAGE_REFERENCE_BUILDERS: Record<ImageReferenceStyle, (absolutePath: string) => string> = {
  'at-quoted': (absolutePath) => `@"${absolutePath}"`,
  // La ruta sola: la CLI adjunta si el pegado entero es la ruta de una imagen.
  // Sin comillas, porque las comillas harian que ya no lo fuera.
  'bare-path-paste': (absolutePath) => absolutePath,
};

// ---------------------------------------------------------------------------
// Respuestas a una pregunta de eleccion
// ---------------------------------------------------------------------------

/** Avanza a la solapa siguiente del menu de preguntas. */
const TAB = '\t';

/**
 * Espera entre una pulsacion y la siguiente al responder el menu.
 *
 * **No es prudencia: sin esto no funciona.** Medido contra la CLI 2.1.259 sobre
 * la misma pregunta, mandando `1` `3` Tab `2` `1`:
 *
 * | Separacion | Resultado |
 * |---|---|
 * | todas en un write | el menu se queda a mitad y no responde nada |
 * | 80 ms | responde las dos preguntas y envia |
 *
 * Es la diferencia con un mensaje del cuadro de escritura, que si va en un solo
 * write (§5.3): alla el flujo es *texto* y la CLI lo consume entero; aca son
 * teclas que mueven un menu, y cada una tiene que caer sobre el estado que
 * dejo la anterior. 120 ms deja margen sobre lo medido sin que se note: cinco
 * pulsaciones son poco mas de medio segundo.
 */
export const ANSWER_KEY_INTERVAL_MS = 120;

/**
 * Enter. Confirma el texto de una respuesta libre dentro del menu.
 *
 * Es el mismo byte que `SUBMIT` y esta aparte a proposito: alla envia un
 * mensaje, aca cierra la edicion de una opcion. Que coincidan es del terminal,
 * no de la CLI.
 */
const CONFIRM = '\r';

/**
 * Una respuesta libre: el usuario escribio en vez de elegir.
 *
 * La opcion `Type something` que la CLI agrega al final del menu (§5.5.2). El
 * texto viaja como pegado, igual que un mensaje del cuadro de escritura, para
 * que un salto de linea no lo envie a la mitad.
 */
export interface FreeTextAnswer {
  readonly kind: 'free';
  readonly text: string;
}

/** Lo elegido en una pregunta: indices de opciones, o texto propio. */
export type AnswerSelection = readonly number[] | FreeTextAnswer;

function isFreeText(value: AnswerSelection): value is FreeTextAnswer {
  return !Array.isArray(value) && (value as FreeTextAnswer).kind === 'free';
}

/**
 * Traduce lo elegido en el chat a las teclas que responden el menu de la CLI.
 *
 * **Esto es lo unico del proyecto que escribe a ciegas en un TUI con estado**, y
 * por eso las reglas de aca no se dedujeron: se midieron lanzando la CLI en una
 * pty, pintando su pantalla y leyendo el `toolUseResult` que quedaba en el
 * JSONL. La tabla es de la **2.1.260**, remedida entera en el hito 16 porque el
 * menu cambio: ahora trae dos opciones mas que la CLI agrega sola.
 *
 * | Caso | Teclas | Resultado |
 * |---|---|---|
 * | 1 pregunta simple | `2` | elige y **envia**, sin pantalla de resumen |
 * | 2 preguntas simples | `1` `2` | queda en `1. Submit answers`: **falta el `1`** |
 * | 3 preguntas simples | `1` `1` `2` `1` | las tres y envia |
 * | 1 pregunta multiSelect | `1` `3` Tab | queda en `1. Submit answers` |
 * | respuesta libre (1 pregunta) | `3` + texto + Enter | envia |
 * | respuesta libre (1ª de 2) | `3` + texto + Enter, `1`, `1` | las dos y envia |
 *
 * De ahi salen las cuatro reglas:
 *
 *  1. **El numero de la opcion es su posicion, 1-based, en el mismo array que
 *     viaja al navegador.** La CLI numera en pantalla siguiendo ese orden.
 *  2. **Una pregunta de opcion unica avanza sola** al elegir; una de opcion
 *     multiple se queda marcando, y hay que sacarla con Tab.
 *  3. Al terminar la ultima pregunta el menu muestra `1. Submit answers`, y ese
 *     `1` es lo que envia. La excepcion es el caso mas comun —una sola pregunta
 *     de opcion unica—, donde el numero ya envio y esa pantalla no aparece.
 *  4. **La respuesta libre es una opcion mas**, la que sigue a las reales:
 *     `Type something` esta en la posicion `optionCount + 1`. Teclear su numero
 *     abre la edicion en el sitio, el texto se pega, y el Enter la confirma
 *     igual que si se hubiera elegido una opcion.
 *
 * Lo que esto asume, y no puede comprobar: que el menu esta recien abierto y
 * nadie lo movio desde la terminal. Es la razon por la que la tarjeta deja de
 * aceptar clics apenas manda, y por la que esto no reintenta nunca.
 *
 * Devuelve las pulsaciones por separado —no una cadena— porque hay que
 * escribirlas espaciadas: ver `ANSWER_KEY_INTERVAL_MS`. Y devuelve null si lo
 * elegido no describe una respuesta valida —un indice que no existe, una
 * pregunta sin responder, dos opciones en una pregunta de opcion unica—:
 * mandar una secuencia a medias deja el menu a mitad de camino con teclas
 * sueltas escritas en el prompt, que es peor que no mandar nada.
 */
export function buildAnswerKeys(
  questions: readonly { readonly multiSelect: boolean; readonly optionCount: number }[],
  selections: readonly AnswerSelection[],
): string[] | null {
  if (questions.length === 0 || selections.length !== questions.length) return null;

  const keys: string[] = [];
  for (const [index, question] of questions.entries()) {
    const chosen = selections[index];
    if (chosen === undefined) return null;

    if (isFreeText(chosen)) {
      // Regla 4. El texto se sanea como el de cualquier envio: un `ESC[201~`
      // adentro cerraria el pegado y el resto entraria como teclas.
      const clean = sanitizeForPaste(chosen.text).trim();
      if (clean.length === 0 || clean.length > MAX_SUBMIT_CHARS) return null;
      // La opcion libre queda detras de las reales; con nueve o mas, su numero
      // ya no se puede teclear (ver abajo).
      if (question.optionCount >= 9) return null;
      keys.push(String(question.optionCount + 1));
      keys.push(`${PASTE_START}${clean}${PASTE_END}`);
      keys.push(CONFIRM);
      // Una pregunta de opcion multiple sigue necesitando su Tab: el texto
      // confirma la opcion, no cierra la pregunta.
      if (question.multiSelect) keys.push(TAB);
      continue;
    }

    if (chosen.length === 0) return null;
    if (!question.multiSelect && chosen.length !== 1) return null;
    if (new Set(chosen).size !== chosen.length) return null;

    for (const option of chosen) {
      if (!Number.isInteger(option) || option < 0 || option >= question.optionCount) {
        return null;
      }
      // Un menu con mas de nueve opciones no se puede responder tecleando el
      // numero: el `10` entraria como `1` y despues `0`. El esquema de la
      // herramienta admite cuatro, asi que no deberia pasar nunca; si pasa,
      // no se manda nada y la pregunta se contesta desde la solapa CLI.
      if (option >= 9) return null;
      keys.push(String(option + 1));
    }
    if (question.multiSelect) keys.push(TAB);
  }

  // Regla 3: la pantalla de resumen aparece siempre menos en el caso de una
  // sola pregunta de opcion unica, donde el numero —o el Enter que confirma el
  // texto libre— ya envio.
  const single = questions.length === 1 && questions[0]?.multiSelect === false;
  if (!single) keys.push('1');

  return keys;
}

/**
 * Las pulsaciones que llevan del modo de permiso actual al que se pidio.
 *
 * `shift+tab` es lo unico que cambia el modo en una sesion viva —la CLI 2.1.260
 * no tiene comando de barra para esto— y **cicla**, asi que hay que saber donde
 * se esta parado. La cuenta la hace `cycleDistance`; aca solo se repite la
 * secuencia esa cantidad de veces.
 *
 * Devuelve null si no hay forma de llegar ciclando (un modo fuera del ciclo) y
 * una lista vacia si ya se esta en el destino, que no es un error: es que no
 * hay nada que escribir.
 */
export function buildModeKeys(from: string, to: string): string[] | null {
  const distance = cycleDistance(from, to);
  if (distance === null) return null;
  return Array.from({ length: distance }, () => SHIFT_TAB);
}

/**
 * Los Esc que interrumpen un turno, uno por pulsacion
 * (`AgentInput.interruptPresses`).
 *
 * Por separado y no en una cadena, por lo mismo que las teclas de un menu: una
 * CLI que arma la interrupcion con el primero tiene que ver el segundo como
 * otra pulsacion. Nunca menos de uno: un boton de interrumpir que no escribe
 * nada es peor que uno que escribe de mas.
 */
export function buildInterruptKeys(presses: number): string[] {
  const count = Number.isInteger(presses) && presses > 1 ? presses : 1;
  return Array.from({ length: count }, () => INTERRUPT);
}

/**
 * Arma lo que se le escribe a la pty para un envio del cuadro de escritura.
 *
 * El orden es el que se ve en pantalla: primero los adjuntos, en el orden en
 * que se pegaron, y despues lo que se escribio. Que coincida con la pantalla
 * es lo unico que hace predecible el resultado.
 *
 * Devuelve `null` si no hay nada que mandar: un Enter en un cuadro vacio no
 * tiene por que llegarle a la CLI.
 */
export function buildSubmission(
  text: string,
  attachments: readonly string[],
  options: { readonly send?: boolean } = {},
): string | null {
  const payload = joinedPayload(text, attachments);
  if (payload === null) return null;

  const send = options.send ?? true;
  return `${pasted(payload, true)}${send ? SUBMIT : ''}`;
}

/** Adjuntos y texto en un solo pegado, recortado. null si no queda nada. */
function joinedPayload(text: string, attachments: readonly string[]): string | null {
  const pieces: string[] = [...attachments];
  const clean = sanitizeForPaste(text).trim();
  if (clean.length > 0) pieces.push(clean);

  const payload = pieces.join(' ').slice(0, MAX_SUBMIT_CHARS);
  return payload.length === 0 ? null : payload;
}

/** Un texto ya saneado, con o sin los marcadores de pegado. */
function pasted(payload: string, markers: boolean): string {
  return markers ? `${PASTE_START}${payload}${PASTE_END}` : payload;
}

/** Lo que `buildSubmissionWrites` necesita saber de la CLI (`AgentInput`). */
export interface SubmissionShape {
  readonly imageReference: ImageReferenceStyle | null;
  readonly pasteMarkers: boolean;
  /**
   * El Enter como pieza propia aunque no haya imagenes que separar. Ausente es
   * false. Con `bare-path-paste` el Enter ya va aparte y esto no cambia nada.
   */
  readonly enterSeparately?: boolean;
}

/**
 * Las piezas de un envio del cuadro de escritura, cada una para un write propio.
 *
 * Quien escribe las separa con el `pieceGapMs` de la CLI. La forma depende de
 * como nombra las imagenes:
 *
 *  - `at-quoted` (y sin imagenes, cualquier CLI sin estilo): **una sola pieza**,
 *    la de `buildSubmission` —adjuntos y texto en un pegado, con el Enter
 *    pegado al final—. Con marcadores es, byte por byte, lo que se escribia
 *    antes de que hubiera piezas.
 *  - `bare-path-paste`: un pegado por imagen con la ruta sola, despues el del
 *    texto, y el Enter como pieza aparte. Sueltas y no concatenadas: si la CLI
 *    recibe lo pegado como rafaga de teclas, dos pegados seguidos en el tiempo
 *    se funden en uno, "ruta1ruta2texto", que ya no es la ruta de nada.
 *  - Sin `bare-path-paste` pero con `enterSeparately`: la misma pieza unica sin
 *    el Enter, y el Enter aparte. Es para la CLI que puede recibir lo pegado
 *    como rafaga y decidir por el tiempo si un Enter es parte de ella.
 *
 * Devuelve null si no hay nada que mandar, y tambien si hay imagenes y la CLI
 * no tiene forma de nombrarlas: el socket lo rechaza antes, y esto no escribe
 * a medias un mensaje sin sus imagenes.
 */
export function buildSubmissionWrites(
  text: string,
  imagePaths: readonly string[],
  shape: SubmissionShape,
  options: { readonly send?: boolean } = {},
): string[] | null {
  const send = options.send ?? true;
  const style = shape.imageReference;
  if (imagePaths.length > 0 && style === null) return null;

  if (style !== 'bare-path-paste') {
    const payload = joinedPayload(
      text,
      imagePaths.map((imagePath) => fileReference(imagePath, style ?? 'at-quoted')),
    );
    if (payload === null) return null;
    if (shape.enterSeparately === true) {
      return send ? [pasted(payload, shape.pasteMarkers), SUBMIT] : [pasted(payload, shape.pasteMarkers)];
    }
    return [`${pasted(payload, shape.pasteMarkers)}${send ? SUBMIT : ''}`];
  }

  const pieces: string[] = [];
  for (const imagePath of imagePaths) {
    const clean = sanitizeForPaste(fileReference(imagePath, style)).trim();
    if (clean.length > 0) pieces.push(pasted(clean, shape.pasteMarkers));
  }
  const clean = sanitizeForPaste(text).trim().slice(0, MAX_SUBMIT_CHARS);
  if (clean.length > 0) pieces.push(pasted(clean, shape.pasteMarkers));

  if (pieces.length === 0) return null;
  if (send) pieces.push(SUBMIT);
  return pieces;
}
