/**
 * Contestar una pregunta de OpenCode por la API de su `serve` (hito 29, D10, A1).
 *
 * La tarjeta del hilo sale de una parte `tool` `question` de la base, y su
 * `toolUseId` es el id de esa parte (`events.ts`). El pedido que hay que
 * contestar es otra cosa: un `que_...` del `serve`, que solo se casa con la
 * parte por su `callID` y su `messageID`. Por eso:
 *
 *  1. De la base se lee **una** parte, por id y sesion (`partCallById`): su
 *     mensaje y su `callID`. Sin fila, la pregunta no es de esa sesion.
 *  2. Los pendientes se piden **en el momento**, con la carpeta de la pestana
 *     (A1): un mapa alimentado por eventos puede estar viejo justo cuando
 *     alguien contesta, y sin la carpeta el `serve` responde por la suya.
 *  3. Se valida contra las opciones **del pedido**, no contra las de la
 *     tarjeta: lo que se manda son etiquetas, y tienen que ser las que la CLI
 *     espera.
 *
 * Nada se manda si la pregunta no esta pendiente o lo elegido no la contesta.
 * Un fallo al mandar lanza: lo traduce quien llama.
 */

import type { AnswerSelection } from '@agent-workbench/shared';
import type { QuestionAnswerOutcome, QuestionChannel } from '../adapter.js';
import { sanitizeForPaste } from '../../pty-input.js';
import type { ReadOnlyDatabase } from '../sqlite.js';
import type { OpenCodeServeClient } from './serve-client.js';
import { OPENCODE_SQL, type PartCallRow } from './sql.js';

/** Largo maximo de una respuesta escrita, ya saneada y sin espacios a los lados. */
export const OPENCODE_FREE_ANSWER_MAX_CHARS = 2_000;

/** El mensaje y la llamada de una parte `question` de la base. */
export interface PartCall {
  messageId: string;
  callId: string;
}

export interface OpenCodeQuestionsDeps {
  /** La parte de la pregunta, o null si no esta o no es de esa sesion. Puede lanzar si la base falla. */
  lookupCall(partId: string, sessionId: string): PartCall | null;
  /** El cliente del `serve` vigente, o null si no hay `serve`. */
  client(): Pick<OpenCodeServeClient, 'pendingQuestions' | 'replyQuestion'> | null;
}

/** `partCallById` sobre la base en solo lectura. */
export function readPartCall(db: ReadOnlyDatabase, partId: string, sessionId: string): PartCall | null {
  const row = db.get<PartCallRow>(OPENCODE_SQL.partCallById, { $id: partId, $s: sessionId });
  if (row === undefined || typeof row.message_id !== 'string' || typeof row.call_id !== 'string' || row.call_id.length === 0) {
    return null;
  }
  return { messageId: row.message_id, callId: row.call_id };
}

/**
 * Lo elegido, traducido a lo que espera `POST /question/{id}/reply`: por
 * pregunta, las etiquetas elegidas en el orden de las opciones, o el texto
 * escrito. null si no describe una respuesta valida.
 */
export function answersFor(
  questions: readonly { options: readonly { label: string }[]; multiple: boolean; custom: boolean }[],
  selections: readonly AnswerSelection[],
): string[][] | null {
  if (questions.length === 0 || selections.length !== questions.length) return null;
  const answers: string[][] = [];
  for (const [index, question] of questions.entries()) {
    const chosen = selections[index];
    if (chosen === undefined) return null;

    if (!Array.isArray(chosen)) {
      if (!question.custom) return null;
      const text = sanitizeForPaste(chosen.text).trim();
      if (text.length === 0 || text.length > OPENCODE_FREE_ANSWER_MAX_CHARS) return null;
      answers.push([text]);
      continue;
    }

    if (chosen.length === 0) return null;
    if (!question.multiple && chosen.length !== 1) return null;
    if (new Set(chosen).size !== chosen.length) return null;
    for (const option of chosen) {
      if (!Number.isInteger(option) || option < 0 || option >= question.options.length) return null;
    }
    answers.push([...chosen].sort((a, b) => a - b).map((option) => question.options[option]?.label ?? ''));
  }
  return answers;
}

/**
 * true si lo elegido trae una respuesta escrita para una pregunta que no la
 * acepta (`custom: false`). Separa ese caso de `invalid` para que la tarjeta
 * diga por que (B4).
 */
export function refusesFreeText(
  questions: readonly { custom: boolean }[],
  selections: readonly AnswerSelection[],
): boolean {
  return selections.length === questions.length &&
    selections.some((chosen, index) => !Array.isArray(chosen) && questions[index]?.custom === false);
}

export class OpenCodeQuestions implements QuestionChannel {
  constructor(private readonly deps: OpenCodeQuestionsDeps) {}

  async answer(
    target: { cwd: string; sessionId: string },
    toolUseId: string,
    selections: readonly AnswerSelection[],
  ): Promise<QuestionAnswerOutcome> {
    const call = this.deps.lookupCall(toolUseId, target.sessionId);
    if (call === null) return 'not-pending';
    const client = this.deps.client();
    if (client === null) return 'not-pending';

    const pending = await client.pendingQuestions(target.cwd);
    const request = pending.find((item) =>
      item.sessionID === target.sessionId && item.tool !== null &&
      item.tool.callID === call.callId && item.tool.messageID === call.messageId);
    if (request === undefined) return 'not-pending';

    const answers = answersFor(request.questions, selections);
    if (answers === null) return refusesFreeText(request.questions, selections) ? 'no-free-text' : 'invalid';

    await client.replyQuestion(target.cwd, request.id, answers);
    return 'answered';
  }
}
