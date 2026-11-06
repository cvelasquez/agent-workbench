/**
 * Las preguntas y aprobaciones de Antigravity CLI leidas de su pantalla emulada.
 *
 * Reconoce:
 *  - El menu numerado de aprobacion de comandos:
 *    1. Yes, run command
 *    2. Yes, run this command and all future commands like it without asking
 *    3. Yes, auto-approve all commands for this session
 *    4. No, cancel
 *  - Preguntas de eleccion multiple (`ask_question`).
 */

import type { AnswerSelection, ConversationQuestionItem, ConversationQuestionOption } from '@agent-workbench/shared';
import { ANSWER_KEY_INTERVAL_MS, sanitizeForPaste } from '../../pty-input.js';
import type { ScreenQuestion, ScreenQuestionReader } from '../adapter.js';

const OPTION_PATTERN = /^(?:[›❯]\s*)?(\d+)\.\s+(.+)$/;

/**
 * Lee el menu de aprobacion de comando de Antigravity si se ve en pantalla.
 */
function readCommandApproval(rows: readonly string[]): ScreenQuestion | null {
  const yesIndex = rows.findIndex((row) => /(?:1\.\s+Yes,\s+run\s+command|1\.\s+Yes\b)/i.test(row));
  const noIndex = rows.findIndex((row) => /(?:4\.\s+No,\s+cancel|No,\s+cancel)/i.test(row));

  if (yesIndex < 0 || noIndex <= yesIndex) return null;

  const headerRows = rows.slice(0, yesIndex).filter((r) => r.length > 0);
  const question = headerRows.length > 0 ? headerRows.join('\n') : 'Command execution requires approval';

  const options: ConversationQuestionOption[] = [];
  let selected = 0;

  for (let i = yesIndex; i <= noIndex; i++) {
    const row = rows[i] ?? '';
    const match = OPTION_PATTERN.exec(row);
    if (match === null) continue;
    const num = Number(match[1]);
    const label = (match[2] ?? '').trim();
    if (num === options.length + 1) {
      if (/^[›❯]/.test(row)) selected = num;
      options.push({ label, description: '' });
    }
  }

  if (options.length < 2) return null;

  const item: ConversationQuestionItem = {
    header: 'Approval',
    question,
    options,
    multiSelect: false,
    allowWriteIn: false,
  };

  return {
    item,
    key: `agy-approval:${JSON.stringify(item)}`,
    untouched: selected <= 1,
  };
}

/**
 * Lee preguntas de eleccion (e.g. ask_question).
 */
function readChoiceQuestion(rows: readonly string[]): ScreenQuestion | null {
  const firstOption = rows.findIndex((row) => /^(?:[›❯]\s*)?1\.\s+/.test(row));
  if (firstOption <= 0) return null;

  const promptRows = rows.slice(0, firstOption).filter((r) => r.length > 0);
  if (promptRows.length === 0) return null;

  const question = promptRows.join('\n');
  const options: ConversationQuestionOption[] = [];
  let selected = 0;

  for (let i = firstOption; i < rows.length; i++) {
    const row = rows[i] ?? '';
    const match = OPTION_PATTERN.exec(row);
    if (match === null) {
      if (options.length > 0 && /^[─=\s]*$/.test(row)) break;
      continue;
    }
    const num = Number(match[1]);
    const label = (match[2] ?? '').trim();
    if (num === options.length + 1) {
      if (/^[›❯]/.test(row)) selected = num;
      options.push({ label, description: '' });
    }
  }

  if (options.length < 2) return null;

  const item: ConversationQuestionItem = {
    header: 'Question',
    question,
    options,
    multiSelect: false,
    allowWriteIn: true,
  };

  return {
    item,
    key: `agy-question:${JSON.stringify(item)}`,
    untouched: selected <= 1,
  };
}

export function readAntigravityQuestion(lines: readonly string[]): ScreenQuestion | null {
  const rows = lines.map((line) => line.trim());
  const approval = readCommandApproval(rows);
  if (approval !== null) return approval;
  return readChoiceQuestion(rows);
}

export function antigravityAnswerKeys(
  _shape: readonly { readonly multiSelect: boolean; readonly optionCount: number }[],
  selections: readonly AnswerSelection[],
  questions?: readonly ConversationQuestionItem[],
): string[] | null {
  if (_shape.length !== 1 || selections.length !== 1) return null;
  const count = _shape[0]?.optionCount ?? 0;
  if (count < 1 || count > 9) return null;

  const selected = selections[0];

  // Si eligio una opcion numerada
  if (Array.isArray(selected) && selected.length === 1) {
    const index = selected[0];
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < count) {
      return [String(index + 1)];
    }
  }

  // Respuesta escrita libre
  if (selected && !Array.isArray(selected) && selected.kind === 'free') {
    if (questions?.[0]?.allowWriteIn === false) return null;
    const text = sanitizeForPaste(selected.text).trim();
    if (text.length === 0 || text.length > 400 || /[\r\n]/.test(text)) return null;
    return [`\x1b[200~${text}\x1b[201~`, '\r'];
  }

  return null;
}

export function createAntigravityScreenQuestions(): ScreenQuestionReader {
  return {
    waitingFor: 'tool_confirmation_pending',
    waitingForKinds: ['tool_confirmation_pending', 'permission prompt', 'input needed'],
    read: readAntigravityQuestion,
    answerKeys: antigravityAnswerKeys,
    keyIntervalMs: ANSWER_KEY_INTERVAL_MS,
  };
}

export const createAntigravityQuestionScreen = createAntigravityScreenQuestions;
