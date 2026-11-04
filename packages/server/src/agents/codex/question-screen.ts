import type { AnswerSelection, ConversationQuestionItem } from '@agent-workbench/shared';
import type { ScreenQuestion, ScreenQuestionReader } from '../adapter.js';
import { sanitizeForPaste } from '../../pty-input.js';

/** Lee la pregunta visible si el menu esta completo, medido con Codex 0.166. */
export function readCodexQuestion(lines: readonly string[]): ScreenQuestion | null {
  const rows = lines.map((line) => line.trim());
  const approval = readCommandApproval(rows);
  if (approval !== null) return approval;
  const start = rows.findIndex((line) => /^Question [1-3]\/[1-3] \([1-3] unanswered\)$/.test(line));
  const end = rows.findIndex((line, index) => index > start && /^tab to add notes \| enter to submit (?:answer|all) \| (?:←\/→ to navigate questions \| )?esc to interrupt$/.test(line));
  if (start < 0 || end < 0) return null;
  const body = rows.slice(start + 1, end).filter(Boolean);
  const question = body.shift();
  if (!question) return null;
  const options: { label: string; description: string }[] = [];
  let selected = 0;
  for (const row of body) {
    const match = /^(›\s*)?(\d+)\.\s+(.+)$/.exec(row);
    if (match === null || Number(match[2]) !== options.length + 1) return null;
    const parts = (match[3] ?? '').split(/\s{2,}/);
    if (match[1]) selected = Number(match[2]);
    options.push({ label: parts[0] ?? '', description: parts.slice(1).join(' ') });
  }
  const other = options.pop();
  if (other?.label !== 'None of the above' || options.length < 1 || options.length > 8 || options.some((item) => !item.label)) return null;
  const item = { question, header: rows[start]?.split(' (')[0] ?? '', multiSelect: false, options };
  return { item, key: JSON.stringify(item), untouched: selected === 1 };
}

/** Una aprobacion de comando solo se acepta cuando se ve el menu entero. */
function readCommandApproval(rows: readonly string[]): ScreenQuestion | null {
  const start = rows.indexOf('Would you like to run the following command?');
  const end = rows.indexOf('Press enter to confirm or esc to cancel');
  if (start < 0 || end <= start) return null;
  const body = rows.slice(start + 1, end).filter(Boolean);
  const first = body.findIndex((row) => /^(?:›\s*)?1\. /.test(row));
  if (first < 1 || !body.slice(0, first).some((row) => row.startsWith('$ '))) return null;
  const options: { label: string; description: string }[] = [];
  let selected = 0;
  for (const row of body.slice(first)) {
    const match = /^(›\s*)?(\d+)\.\s+(.+)$/.exec(row);
    if (match === null || Number(match[2]) !== options.length + 1) return null;
    if (match[1]) selected = Number(match[2]);
    options.push({ label: match[3] ?? '', description: '' });
  }
  if (options.length !== 3 || !options[0]?.label.startsWith('Yes, proceed') || !options[2]?.label.startsWith('No,')) return null;
  const item: ConversationQuestionItem = {
    header: 'Approval',
    question: `${rows[start]}\n\n${body.slice(0, first).join('\n')}`,
    options,
    multiSelect: false,
    allowWriteIn: false,
  };
  return { item, key: JSON.stringify(item), untouched: selected === 1 };
}

/** Los numeros de una opcion envian la respuesta inmediatamente. */
export function codexAnswerKeys(_shape: readonly { readonly multiSelect: boolean; readonly optionCount: number }[], selections: readonly AnswerSelection[], questions?: readonly ConversationQuestionItem[]): string[] | null {
  if (_shape.length !== 1 || selections.length !== 1 || _shape[0]?.multiSelect || (_shape[0]?.optionCount ?? 0) < 1 || (_shape[0]?.optionCount ?? 0) > 8) return null;
  const selected = selections[0];
  if (questions?.[0]?.allowWriteIn === false) {
    if (!Array.isArray(selected) || selected.length !== 1 || _shape[0]?.optionCount !== questions[0].options.length) return null;
    const index = selected[0];
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= _shape[0].optionCount) return null;
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
