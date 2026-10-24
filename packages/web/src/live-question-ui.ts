/**
 * La pregunta leida de la pantalla en la web (23-10-2026, §5.5.4): que tarjeta
 * del historial hereda lo que paso en la leida. Y cuando una tarjeta de
 * pregunta no se puede contestar desde el hilo (24-10-2026, §5.5.3).
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
  askedBeforeLaunch,
  sameQuestionItem,
  type AnswerSelection,
  type ConversationEvent,
  type ConversationQuestionItem,
  type TerminalId,
} from '@agent-workbench/shared';

/**
 * Por que una tarjeta de pregunta no se contesta desde el hilo, o null si se
 * contesta.
 *
 *  - `unsupported`: la CLI de la pestana no contesta con la tarjeta (§5.5); se
 *    responde en la solapa CLI.
 *  - `no-cli`: la pestana no tiene la CLI abierta, dormida o terminada. No hay
 *    quien reciba la respuesta: el clic decia "Respondida" con la respuesta ya
 *    rechazada (24-10-2026, §5.5.3).
 *  - `closed`: la hizo un proceso anterior de la CLI, que se cerro con la
 *    pregunta abierta. La de ahora no tiene ese menu: el clic le mandaba un
 *    numero a su prompt (24-10-2026, §5.5.3).
 */
export type QuestionCardLock = 'unsupported' | 'no-cli' | 'closed' | null;

/** Lo que el candado sabe de la pestana: lo mismo para todas sus tarjetas. */
export interface QuestionCardTab {
  /** La CLI de la pestana contesta con la tarjeta (`questionCards`). */
  questionCards: boolean;
  /** Tiene la CLI abierta. */
  cliOpen: boolean;
  /** Cuando arranco esa CLI (epoch ms), o null si no se sabe. */
  launchedAt: number | null;
}

/**
 * El candado de una tarjeta. `askedAt` es el `at` del evento de la pregunta, y
 * null en la leida de la pantalla, que es siempre de la CLI de ahora.
 * `unsupported` va primero: a una CLI sin tarjetas de pregunta no le cambia
 * nada que este abierta o no.
 */
export function questionCardLock(tab: QuestionCardTab, askedAt: number | null): QuestionCardLock {
  if (!tab.questionCards) return 'unsupported';
  if (!tab.cliOpen) return 'no-cli';
  return askedAt !== null && askedBeforeLaunch(askedAt, tab.launchedAt) ? 'closed' : null;
}

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
