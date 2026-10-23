/**
 * La pregunta de eleccion de Claude Code, leida de su pantalla (23-10-2026,
 * §5.5.4).
 *
 * La CLI no escribe en el historial la linea de `AskUserQuestion` hasta que se
 * contesta (medido con la 2.1.309: tres de tres), y mientras tanto solo publica
 * `waiting` con `input needed`. Lo que si hay es el menu en la pantalla. Medido
 * con la 2.1.309 en una pty como la de la app, leida con el mismo emulador
 * (`docs/herramientas/claude-preguntas/`):
 *
 * ```
 * ────────────────────────────────────────────────
 *  ☐ Base
 *
 * ¿Qué base de datos usamos para el módulo de reportes?
 *
 * ❯ 1. PostgreSQL
 *      La que ya usa el resto del sistema.
 *   2. SQLite
 *      Un archivo local, sin servidor.
 *   3. Type something.
 * ────────────────────────────────────────────────
 *   4. Chat about this
 *
 * Enter to select · ↑/↓ to navigate · Esc to cancel
 * ```
 *
 * Variantes medidas, y lo que se hace con cada una:
 *
 *  - **Una pregunta larga** se dibuja con `│ ` delante de cada linea. Se quita.
 *  - **Terminal angosta**: todo se parte en lineas, el pie tambien. Se juntan.
 *  - **Opcion multiple**: arriba va una barra de solapas (`←  ☐ Revisión  ✔
 *    Submit  →`), cada opcion lleva `[ ]` o `[✔]`, la descripcion va mas
 *    adentro y debajo de "Type something" (sin punto) hay un "Submit". Se lee.
 *  - **Varias preguntas**: la barra tiene una solapa por pregunta y el pie dice
 *    `Tab/Arrow keys`. Solo se ve una: no se lee.
 *  - **Opciones con vista previa**: otro dibujo, sin "Type something", y el
 *    numero no contesta (hace falta Enter). No se lee.
 *  - **Terminal baja**: la lista se recorta con `↑`/`↓` en lugar de la marca y
 *    la pregunta queda fuera de la pantalla. No se lee.
 *
 * Lo que dice si el menu esta tocado: la marca `❯` sobre "Type something" (ahi
 * un numero se escribe como texto, y el pie suma `ctrl+g to edit`), sobre "Chat
 * about this", o una casilla marcada en una de opcion multiple.
 *
 * Estricto a proposito: si una sola linea no tiene la forma medida, no hay
 * pregunta. Lo peor que pasa es lo de antes, la barra de "esperando".
 */

import type { ConversationQuestionOption } from '@agent-workbench/shared';
import type { ScreenQuestion, ScreenQuestionReader } from '../adapter.js';

/** La etiqueta de `waitingFor` con la que la CLI espera la respuesta a una pregunta (ver `cli-status.ts`). */
export const QUESTION_WAITING_FOR = 'input needed';

const SEPARATOR = /^─{8,}$/;
const FOOTER_START = 'Enter to select';
/** El numero y el texto de una opcion. Delante, la marca, una flecha de lista recortada, o un espacio. */
const OPTION = /^([❯↑↓ ]) (\d+)\. (.*)$/;
const CHAT = /^[❯ ] (\d+)\. Chat about this$/;
const TYPE_SOMETHING = /^(?:\[[ ✔]\] )?Type something\.?$/;
const CHECKBOX = /^\[([ ✔])\] (.*)$/;
const SINGLE_HEADER = /^ ([☐☒]) (.+)$/;
const TAB_BAR = /^←\s+(.+?)\s+→$/;
const QUESTION_TAB = /^([☐☒]) (.+)$/;
/** Lo que trae cada linea de la pregunta larga. */
const QUOTE = /^│ ?/;
/** Una linea que sigue a la de su opcion: la descripcion, o el resto de una etiqueta partida. */
const CONTINUATION = /^ {3,}\S/;

/** Espacios juntados: como queda el texto que la CLI partio en lineas. */
function joined(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ');
}

interface Header {
  text: string;
  /** La barra de solapas: va con la opcion multiple (una pregunta y "Submit"). */
  tabBar: boolean;
  /** El cuadrito tachado: algo ya se eligio en la solapa CLI. */
  marked: boolean;
}

function readHeader(line: string): Header | null {
  const single = SINGLE_HEADER.exec(line);
  if (single !== null) return { text: (single[2] ?? '').trim(), tabBar: false, marked: single[1] === '☒' };
  const bar = TAB_BAR.exec(line);
  if (bar === null) return null;
  const tabs = (bar[1] ?? '').split(/\s{2,}/).map((tab) => tab.trim());
  const questions = tabs.flatMap((tab) => {
    const found = QUESTION_TAB.exec(tab);
    return found === null ? [] : [{ text: (found[2] ?? '').trim(), marked: found[1] === '☒' }];
  });
  // Una solapa por pregunta y la de enviar. Con dos preguntas o mas, la pantalla muestra una sola.
  if (questions.length !== 1 || tabs.length !== 2 || !tabs.includes('✔ Submit')) return null;
  const only = questions[0];
  return only === undefined ? null : { text: only.text, tabBar: true, marked: only.marked };
}

interface OptionLines {
  marker: string;
  number: number;
  first: string;
  rest: string[];
}

/** Lee la pantalla de la CLI. null si no hay una pregunta que se pueda contestar desde el hilo. */
export function readQuestionScreen(lines: readonly string[]): ScreenQuestion | null {
  const rows = lines.map((line) => line.replace(/\s+$/, ''));

  // 1. El pie, el ultimo. En una terminal angosta sigue en las lineas de abajo.
  let footer = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if ((rows[index] ?? '').startsWith(FOOTER_START)) {
      footer = index;
      break;
    }
  }
  if (footer === -1) return null;
  const footerText = joined(rows.slice(footer));
  if (!/Esc to\s+cancel$/.test(footerText)) return null;
  // La vista previa (el numero no contesta) y varias preguntas (se ve una sola).
  if (footerText.includes('to add notes') || footerText.includes('Tab/Arrow keys')) return null;
  const editing = footerText.includes('ctrl+g to edit');

  // 2. Las dos rayas: la que cierra la lista y la de arriba de todo.
  const separators: number[] = [];
  for (let index = footer - 1; index >= 0 && separators.length < 2; index -= 1) {
    if (SEPARATOR.test((rows[index] ?? '').trim())) separators.push(index);
  }
  const [bottom, top] = separators;
  if (bottom === undefined || top === undefined) return null;

  // 3. Entre la raya de abajo y el pie, solo "Chat about this".
  const tail = rows.slice(bottom + 1, footer).filter((line) => line.trim().length > 0);
  const chat = tail.length === 1 ? CHAT.exec(tail[0] ?? '') : null;
  if (chat === null) return null;
  const chatNumber = Number(chat[1]);
  const markerOnChat = (tail[0] ?? '').startsWith('❯');

  // 4. El cuerpo: encabezado, pregunta y opciones.
  const body = rows.slice(top + 1, bottom);
  const header = readHeader(body[0] ?? '');
  if (header === null) return null;

  let at = 1;
  while (at < body.length && (body[at] ?? '').trim().length === 0) at += 1;
  const questionLines: string[] = [];
  while (at < body.length && (body[at] ?? '').trim().length > 0) {
    const line = body[at] ?? '';
    if (OPTION.test(line)) break;
    questionLines.push(line.replace(QUOTE, ''));
    at += 1;
  }
  const question = joined(questionLines);
  if (question.length === 0) return null;

  const options: OptionLines[] = [];
  for (; at < body.length; at += 1) {
    const line = body[at] ?? '';
    if (line.trim().length === 0) continue;
    const option = OPTION.exec(line);
    if (option !== null) {
      options.push({ marker: option[1] ?? ' ', number: Number(option[2]), first: (option[3] ?? '').trim(), rest: [] });
      continue;
    }
    const current = options.at(-1);
    if (current === undefined || !CONTINUATION.test(line)) return null;
    current.rest.push(line);
  }

  // 5. Numeradas de corrido, "Type something" al final y "Chat about this" despues.
  if (options.length < 2 || options.some((option, index) => option.number !== index + 1)) return null;
  const typeSomething = options.at(-1);
  if (typeSomething === undefined || !TYPE_SOMETHING.test(typeSomething.first)) return null;
  if (chatNumber !== typeSomething.number + 1) return null;
  // La lista recortada por una terminal baja: no estan todas.
  if (options.some((option) => option.marker === '↑' || option.marker === '↓')) return null;

  const real = options.slice(0, -1);
  const checkboxes = real.map((option) => CHECKBOX.exec(option.first));
  const multiSelect = checkboxes.every((found) => found !== null);
  if (!multiSelect && checkboxes.some((found) => found !== null)) return null;
  // La barra de solapas va con la opcion multiple, y solo con ella.
  if (multiSelect !== header.tabBar) return null;
  // Debajo de "Type something" de una de opcion multiple va "Submit", y nada mas.
  const typeRest = joined(typeSomething.rest);
  if (multiSelect ? typeRest !== 'Submit' : typeRest.length > 0) return null;

  const parsed: ConversationQuestionOption[] = real.map((option, index) => ({
    label: (multiSelect ? (checkboxes[index]?.[2] ?? '') : option.first).trim(),
    description: joined(option.rest),
  }));
  if (parsed.some((option) => option.label.length === 0)) return null;

  const markerOnReal = real.some((option) => option.marker === '❯');
  const checked = checkboxes.some((found) => found?.[1] === '✔');
  const untouched = markerOnReal && !markerOnChat && !editing && !checked && !header.marked;

  return {
    item: { question, header: header.text, multiSelect, options: parsed },
    key: JSON.stringify([header.text, question, multiSelect, parsed.map((option) => [option.label, option.description])]),
    untouched,
  };
}

export function createClaudeCodeScreenQuestions(): ScreenQuestionReader {
  return { waitingFor: QUESTION_WAITING_FOR, read: readQuestionScreen };
}
