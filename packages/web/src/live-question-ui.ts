/**
 * La pregunta leida de la pantalla en la web (23-10-2026, §5.5.4): que tarjeta
 * del historial hereda lo que paso en la leida.
 *
 * La CLI escribe la pregunta en su historial cuando quiere: antes de que se
 * conteste, al contestarla, o en el medio, entre el clic y la respuesta del
 * servidor (medido). La tarjeta leida se va en ese instante y aparece la de
 * verdad, con otro id. Si no hereda lo de la leida, miente: acepta un segundo
 * clic sobre una pregunta ya mandada, o dice "Respondida" con la CLI todavia
 * esperando porque el servidor rechazo la respuesta.
 *
 * Puro, para que lo pruebe `check-live-question.mjs`.
 */

import {
  sameQuestionItem,
  type AnswerSelection,
  type ConversationEvent,
  type ConversationQuestionItem,
  type TerminalId,
} from '@agent-workbench/shared';

/** Lo que se mando en una pregunta leida, hasta que aparece la del historial. */
export interface LiveAnswerRecord {
  terminalId: TerminalId;
  item: ConversationQuestionItem;
  /** Lo elegido, mientras no haya un rechazo. */
  selections: AnswerSelection[] | null;
  /** El motivo del rechazo, si el servidor no la mando. */
  failure: string | null;
}

/** Una tarjeta del historial que hereda lo de una leida. */
export interface LiveCarryOver {
  liveId: string;
  /** El id de la CLI: el de la tarjeta del historial. */
  toolUseId: string;
  selections: AnswerSelection[] | null;
  failure: string | null;
}

/**
 * Que tarjetas del historial heredan lo de las leidas de esta pestana. Se busca
 * desde el final: una pregunta igual de mas arriba, ya contestada, no se lleva
 * lo de la de ahora. Cada leida y cada tarjeta, una sola vez.
 */
export function liveCarryOvers(
  events: readonly ConversationEvent[],
  records: ReadonlyMap<string, LiveAnswerRecord>,
  terminalId: TerminalId,
): LiveCarryOver[] {
  const pending = [...records].filter(([, record]) => record.terminalId === terminalId);
  const found: LiveCarryOver[] = [];
  for (let index = events.length - 1; index >= 0 && pending.length > 0; index -= 1) {
    for (const part of events[index]?.parts ?? []) {
      if (part.kind !== 'question' || part.questions.length !== 1) continue;
      const item = part.questions[0];
      if (item === undefined) continue;
      const at = pending.findIndex(([, record]) => sameQuestionItem(record.item, item));
      const [entry] = at === -1 ? [] : pending.splice(at, 1);
      if (entry === undefined) continue;
      const [liveId, record] = entry;
      found.push({ liveId, toolUseId: part.toolUseId, selections: record.selections, failure: record.failure });
    }
  }
  return found;
}
