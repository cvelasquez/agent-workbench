/**
 * Los mensajes que una CLI devuelve a su editor al interrumpir (hito 43).
 *
 * Medido con Pi (CLAUDE.md 16.5): un mensaje mandado con el agente trabajando
 * queda en cola, y si el turno se interrumpe antes de que lo entregue, Pi lo
 * devuelve a su propio editor sin mandarlo. El mensaje siguiente del cuadro se
 * pegaria a continuacion y saldrian los dos juntos.
 *
 * Lo que se hace, solo cuando la interrupcion sale **de la app** y solo con la
 * CLI que lo declara (`AgentAdapter.queuedSubmits`):
 *
 *  1. Se espera a que el historial diga que el turno quedo cerrado: recien ahi
 *     la CLI ya devolvio lo que tenia en cola.
 *  2. Se le pregunta al adaptador cuales de los mensajes mandados no llegaron
 *     a la sesion. Si llegaron todos, no se toca nada.
 *  3. Se vacia el editor de la CLI con una tecla, separada de cualquier otra
 *     igual: dos seguidas la cierran.
 *  4. Se le devuelve ese texto al cuadro, para que no se pierda.
 *
 * Si el turno no queda cerrado a tiempo —la CLI estaba libre, o el Esc no
 * interrumpio nada— no se escribe ninguna tecla: mandar un Ctrl+C sin saber que
 * hay en el editor es justo lo que esto no hace.
 *
 * Un Esc tecleado en la solapa CLI no pasa por aca: ahi el usuario tiene el
 * editor de la CLI a la vista.
 *
 * Puro, con el reloj inyectado: lo prueba `check-pi-adapter.mjs` sin pty.
 */

import type { TerminalId } from '@agent-workbench/shared';
import type { QueuedSubmission, QueuedSubmitSource } from './agents/adapter.js';

/** Cuantos mensajes se recuerdan por pestana, y hasta cuando. */
const SUBMISSIONS_KEPT = 20;
const SUBMISSION_MAX_AGE_MS = 30 * 60_000;

/** Cuanto se espera a que el historial cierre el turno, y cada cuanto se mira. */
export const RECLAIM_TIMEOUT_MS = 4_000;
export const RECLAIM_POLL_MS = 250;

/**
 * Lo que la app mando a cada pestana y su CLI todavia puede tener en cola.
 *
 * Se olvida cuando la pestana queda libre —el turno termino solo: todo lo que
 * habia en cola se entrego— o sin proceso, y cuando cambia de sesion. Por eso
 * la interrupcion se lleva la lista (`take`) antes de escribir el Esc: el aviso
 * de "libre" que sigue a la interrupcion no puede vaciarla primero.
 */
export class QueuedSubmitBook {
  private readonly submissions = new Map<TerminalId, QueuedSubmission[]>();
  private readonly clearKeyAt = new Map<TerminalId, number>();

  /** Un mensaje termino de escribirse en la pty, Enter incluido. */
  note(terminalId: TerminalId, text: string, at: number): void {
    if (text.trim().length === 0) return;
    const kept = (this.submissions.get(terminalId) ?? []).filter((each) => at - each.at < SUBMISSION_MAX_AGE_MS);
    this.submissions.set(terminalId, [...kept, { text, at }].slice(-SUBMISSIONS_KEPT));
  }

  /** Se lleva lo anotado de esa pestana. */
  take(terminalId: TerminalId): QueuedSubmission[] {
    const taken = this.submissions.get(terminalId) ?? [];
    this.submissions.delete(terminalId);
    return taken;
  }

  /** La pestana quedo libre, sin proceso, o en otra sesion: nada de lo anotado sigue en cola. */
  forget(terminalId: TerminalId): void {
    this.submissions.delete(terminalId);
  }

  /** La pestana se cerro. */
  drop(terminalId: TerminalId): void {
    this.submissions.delete(terminalId);
    this.clearKeyAt.delete(terminalId);
  }

  /** Paso una tecla de vaciar por la pty de esa pestana: de la app, o tecleada por el usuario. */
  noteClearKey(terminalId: TerminalId, at: number): void {
    this.clearKeyAt.set(terminalId, at);
  }

  lastClearKeyAt(terminalId: TerminalId): number | null {
    return this.clearKeyAt.get(terminalId) ?? null;
  }

  /** Pestanas con algo anotado. Para el chequeo. */
  size(): number {
    return this.submissions.size;
  }
}

export interface ReclaimDeps {
  source: QueuedSubmitSource;
  /** La sesion de la pestana ahora, o null si ya no tiene (se cerro, o no tiene id). */
  target: () => { cwd: string; sessionId: string } | null;
  /** Lo que la interrupcion se llevo del libro. */
  submissions: readonly QueuedSubmission[];
  /** Epoch ms de cuando se escribio el Esc. */
  interruptedAt: number;
  /** Epoch ms de la ultima tecla de vaciar que paso por esa pty, o null. */
  lastClearKeyAt: () => number | null;
  /** Escribe la tecla que vacia el editor. false si la terminal no la acepto. */
  writeClearKey: () => boolean;
  /** Devuelve el texto al cuadro de escritura. */
  prefill: (text: string) => void;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Como termino:
 *
 *  - `nothing`: no habia nada mandado, o todo llego a la sesion.
 *  - `not-settled`: el historial no cerro el turno a tiempo. No se escribio nada.
 *  - `gone`: la pestana ya no tiene sesion. No se escribio nada.
 *  - `refused`: la terminal no acepto la tecla. No se devolvio nada al cuadro:
 *    sin vaciar el editor, el texto estaria en los dos lados.
 *  - `reclaimed`: se vacio el editor y el texto volvio al cuadro.
 */
export type ReclaimOutcome = 'nothing' | 'not-settled' | 'gone' | 'refused' | 'reclaimed';

export async function reclaimQueuedSubmits(deps: ReclaimDeps): Promise<ReclaimOutcome> {
  // Lo mandado despues del Esc no estaba en cola cuando se interrumpio.
  const submissions = deps.submissions.filter((each) => each.at <= deps.interruptedAt);
  if (submissions.length === 0) return 'nothing';

  const timeoutMs = deps.timeoutMs ?? RECLAIM_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? RECLAIM_POLL_MS;
  const deadline = deps.now() + timeoutMs;
  let undelivered: readonly string[] = [];
  for (;;) {
    const target = deps.target();
    if (target === null) return 'gone';
    const result = await deps.source.check(target, submissions, deps.interruptedAt);
    if (result.undelivered.length === 0) return 'nothing';
    if (result.settled) {
      undelivered = result.undelivered;
      break;
    }
    if (deps.now() >= deadline) return 'not-settled';
    await deps.wait(pollMs);
  }

  // Dos teclas de vaciar seguidas cierran la CLI: se espera lo que falte.
  const last = deps.lastClearKeyAt();
  if (last !== null) {
    const remaining = deps.source.clearGapMs - (deps.now() - last);
    if (remaining > 0) await deps.wait(remaining);
  }
  if (deps.target() === null) return 'gone';
  if (!deps.writeClearKey()) return 'refused';

  deps.prefill(undelivered.join('\n\n'));
  return 'reclaimed';
}
