import type { AnswerSelection, ConversationQuestionItem } from '@agent-workbench/shared';
import type { ScreenQuestion, ScreenQuestionReader } from '../adapter.js';
import { sanitizeForPaste } from '../../pty-input.js';
import { parseCodexMenu, type CodexMenu, type CodexMenuOption } from './menu-screen.js';

/**
 * Lee el menu visible si es una pregunta o una aprobacion que se contesta desde
 * el hilo, medido con Codex 0.167 (§10.23). Del menu se ocupa `menu-screen.ts`,
 * que deshace el ajuste de linea de la terminal; aca se decide que menus tienen
 * tarjeta y con que opciones.
 *
 * Lo que no tiene la forma medida no es una pregunta: devuelve null y la CLI
 * sigue siendo el lugar donde se contesta.
 */
export function readCodexQuestion(lines: readonly string[]): ScreenQuestion | null {
  const menu = parseCodexMenu(lines);
  // Sin la opcion 1 a la vista alguien ya movio la lista en la solapa CLI.
  if (menu === null || menu.moreAbove || menu.options.length === 0) return null;
  switch (menu.kind) {
    case 'question':
      return readQuestion(menu);
    case 'command':
    case 'edits':
    case 'terminal-input':
      return readApproval(menu);
    case 'mcp':
      return readToolApproval(menu);
    case 'plan':
      return readPlan(menu);
    default:
      return null;
  }
}

function cardOf(item: ConversationQuestionItem, menu: CodexMenu): ScreenQuestion {
  return { item, key: JSON.stringify(item), untouched: menu.selected === 1 };
}

const plainOptions = (options: readonly CodexMenuOption[]): { label: string; description: string }[] =>
  options.map(({ label, description }) => ({ label, description }));

/** La pregunta del modelo (modo Plan): sus opciones y "None of the above", con notas aparte. */
function readQuestion(menu: CodexMenu): ScreenQuestion | null {
  const question = menu.body[0];
  if (!question) return null;
  const options = menu.options.slice(0, -1);
  const other = menu.options.at(-1);
  if (other?.label !== 'None of the above' || options.length < 1 || options.length > 8 || options.some((item) => !item.label)) return null;
  const item = { question, header: menu.title.split(' (')[0] ?? '', multiSelect: false, options: plainOptions(options) };
  return cardOf(item, menu);
}

/** El atajo con que Codex cierra la etiqueta de una opcion de aprobacion: `(y)`, `(a)`, `(p)`, `(esc)`. */
const SHORTCUT = /\((?:y|a|p|r|d|n|esc)\)$/;
/** La ultima opcion de una aprobacion, que es la misma en todas las familias medidas. */
export const CODEX_DENY_LABEL = 'No, and tell Codex what to do differently (esc)';

/**
 * Comando, edicion de archivos y entrada a una terminal: una aprobacion con
 * `Yes, proceed` primero y la negativa al final. Solo se ofrecen las opciones
 * completas. Con la terminal baja Codex corta la ultima opcion que cabe, o
 * deja de dibujar las que siguen, a veces sin ninguna marca: la etiqueta cortada
 * mentiria sobre el alcance de lo que se aprueba ("commands that start with
 * ..."), asi que no se ofrece, y la negativa que no se ve se agrega, porque
 * `Esc` la contesta sin verla (`codexAnswerKeys`).
 */
function readApproval(menu: CodexMenu): ScreenQuestion | null {
  if (!menu.options[0]?.label.startsWith('Yes, proceed')) return null;
  const complete: CodexMenuOption[] = [];
  for (const option of menu.options) {
    if (!SHORTCUT.test(option.label)) break;
    complete.push(option);
  }
  if (complete.length === 0) return null;
  const closed = /^No\b/.test(complete.at(-1)?.label ?? '');
  const shown = closed ? complete : [...complete, { number: complete.length + 1, label: CODEX_DENY_LABEL, description: '' }];
  const item: ConversationQuestionItem = {
    header: 'Approval',
    question: [menu.title, '', ...menu.body].join('\n'),
    options: shown.map(({ label }) => ({ label, description: '' })),
    multiSelect: false,
    allowWriteIn: false,
  };
  return cardOf(item, menu);
}

/** La herramienta de un servidor MCP: Allow, Allow for this session, Always allow y Cancel. */
function readToolApproval(menu: CodexMenu): ScreenQuestion | null {
  const question = menu.body[0];
  if (!question || menu.options.length < 2) return null;
  if (!menu.options[0]?.label.startsWith('Allow') || !/^Cancel\b/.test(menu.options.at(-1)?.label ?? '')) return null;
  const item: ConversationQuestionItem = {
    header: 'Approval',
    question: [question, '', ...menu.body.slice(1)].join('\n').trim(),
    options: plainOptions(menu.options),
    multiSelect: false,
    allowWriteIn: false,
  };
  return cardOf(item, menu);
}

/** "Implement this plan?", al terminar el modo Plan. */
function readPlan(menu: CodexMenu): ScreenQuestion | null {
  if (!menu.options[0]?.label.startsWith('Yes, implement') || !/^No, stay/.test(menu.options.at(-1)?.label ?? '')) return null;
  const item: ConversationQuestionItem = {
    header: 'Plan',
    question: menu.title,
    options: plainOptions(menu.options),
    multiSelect: false,
    allowWriteIn: false,
  };
  return cardOf(item, menu);
}

/** Los numeros de una opcion envian la respuesta inmediatamente. */
export function codexAnswerKeys(_shape: readonly { readonly multiSelect: boolean; readonly optionCount: number }[], selections: readonly AnswerSelection[], questions?: readonly ConversationQuestionItem[]): string[] | null {
  if (_shape.length !== 1 || selections.length !== 1 || _shape[0]?.multiSelect || (_shape[0]?.optionCount ?? 0) < 1 || (_shape[0]?.optionCount ?? 0) > 8) return null;
  const selected = selections[0];
  if (questions?.[0]?.allowWriteIn === false) {
    if (!Array.isArray(selected) || selected.length !== 1 || _shape[0]?.optionCount !== questions[0].options.length) return null;
    const index = selected[0];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= _shape[0].optionCount) return null;
    // El atajo de la etiqueta cierra el menu aunque la terminal no dibuje esa opcion.
    if (/\(esc\)$/.test(questions[0].options[index]?.label ?? '')) return ['\x1b'];
    return [...Array(index).fill('\x1b[B'), '\r'];
  }
  if (selected && !Array.isArray(selected)) {
    const text = sanitizeForPaste(selected.text).trim();
    if (!text || text.length > 400 || /[\r\n]/.test(text)) return null;
    return [...Array(_shape[0]?.optionCount ?? 0).fill('\x1b[B'), '\t', `\x1b[200~${text}\x1b[201~`, '\r'];
  }
  if (!Array.isArray(selected) || selected.length !== 1) return null;
  const index = selected[0];
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < (_shape[0]?.optionCount ?? 0) && index < 9 ? [String(index + 1)] : null;
}

export function createCodexScreenQuestions(): ScreenQuestionReader {
  return { waitingFor: 'input needed', waitingForKinds: ['permission prompt'], read: readCodexQuestion, answerKeys: codexAnswerKeys, keyIntervalMs: 400 };
}
