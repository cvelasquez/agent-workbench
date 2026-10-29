/**
 * Mandarle un mensaje programado a una CLI que no avisa cuando esta lista
 * (hito 52, §6.39): Codex, Pi y Antigravity por su pantalla, OpenCode por su
 * API. Claude Code sigue por `deliverWhenReady` (hito 51).
 *
 * Tres pasos, con todo inyectado para que el chequeo lo pruebe sin pty:
 *
 *  1. **Libre y lista.** Libre lo dice el estado que la CLI publica o, si no
 *     publica nada (Codex), el turno abierto de su historial (`hasOpenTurn`).
 *     Lista lo dice su pantalla emulada (`readyScreen`, lo medido de cada CLI),
 *     dos lecturas seguidas iguales: un redibujo que llega en dos trozos deja un
 *     instante la pantalla a medio cambiar (§6.35.1). OpenCode no mira la
 *     pantalla: su API recibe el mensaje aunque el TUI no este dibujado.
 *  2. **Escribirlo** por el camino del cuadro (`submit-message.ts`), con sus
 *     guardas, o por la API.
 *  3. **Verlo llegar**: un mensaje del usuario con ese texto en la
 *     conversacion, despues de escribirlo, o el estado que pasa a trabajando.
 *     Si no aparece en el plazo de la CLI, queda "no se sabe si llego" y no se
 *     reintenta: mandarlo dos veces es peor que pedirle al usuario que mire.
 *
 * Si la CLI sigue trabajando todo el plazo no se escribe nada (`busy`): el reloj
 * lo vuelve a intentar, como espera cuando el agente trabaja.
 */

import type { ConversationEvent, TerminalActivity, TerminalId } from '@agent-workbench/shared';
import type { ScheduledSendSupport, SessionFollower } from '../agents/adapter.js';
import type { DeliverOutcome } from '../deliver-when-ready.js';
import type { SubmitResult } from '../submit-message.js';

/** Cada cuanto se mira, esperando a la CLI y despues el mensaje. */
export const SCHEDULED_POLL_MS = 250;

export type ScheduledDeliveryOutcome =
  | DeliverOutcome
  /** La CLI siguio trabajando todo el plazo: no se escribio nada, y se vuelve a intentar. */
  | { kind: 'busy' }
  /** Se escribio (o la API lo acepto) y no aparecio en la conversacion en el plazo. */
  | { kind: 'unconfirmed' };

/** Lo que el envio mira de la pestana en cada vuelta. */
export interface DeliveryTabState {
  alive: boolean;
  sessionId: string;
  cwd: string;
  /** Epoch ms del lanzamiento de la pty viva, o null. */
  launchedAt: number | null;
}

export interface ScheduledDeliveryDeps {
  /** La pestana ahora, o null si ya no esta. */
  tab(terminalId: TerminalId): DeliveryTabState | null;
  activityOf(terminalId: TerminalId): TerminalActivity | null;
  /** La pantalla emulada de la pestana, o null si no tiene proceso. */
  screen(terminalId: TerminalId): { lines(): readonly string[] | Promise<readonly string[]>; dispose(): void } | null;
  /** El envio del cuadro con sus guardas, solo texto. `refusal`: se rechazo antes de escribir nada. */
  submit(terminalId: TerminalId, text: string): Promise<SubmitResult | { kind: 'refusal' }>;
  /** Sigue la conversacion de la pestana (`HistorySource.follow`). */
  follow(target: { cwd: string; sessionId: string }): SessionFollower;
  now(): number;
  wait(ms: number): Promise<void>;
}

export interface ScheduledDeliveryRequest {
  terminalId: TerminalId;
  text: string;
  support: ScheduledSendSupport;
  /** La CLI publica su estado. Si no (Codex), libre es sin turno abierto en el historial. */
  hasStatus: boolean;
  /** Cuanto se espera a que la CLI quede libre y lista. */
  readyTimeoutMs: number;
  pollMs?: number;
}

/** Espacios juntados: la CLI puede guardar los saltos de linea distinto de como se escribieron. */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** true si el evento es un mensaje del usuario con ese texto. */
export function isUserMessageWith(event: ConversationEvent, text: string): boolean {
  if (event.role !== 'user') return false;
  const said = normalized(event.parts.map((part) => (part.kind === 'text' ? part.text : '')).join(' '));
  const sent = normalized(text);
  if (said.length === 0 || sent.length === 0) return false;
  // Un mensaje largo puede llegar recortado al hilo (§4.11): alcanza con el principio.
  const head = sent.slice(0, 200);
  return said === sent || said.includes(head) || (said.length >= 40 && sent.startsWith(said.slice(0, 200)));
}

type Freeness = 'idle' | 'busy' | 'waiting' | 'unknown';

/**
 * Si la CLI esta libre ahora: por su estado, o por el turno abierto del
 * historial. Lo usa tambien el reloj antes de empezar un envio.
 */
export async function freenessOf(
  hasStatus: boolean,
  activity: TerminalActivity | null,
  follower: SessionFollower | null,
  launchedAt: number | null,
): Promise<Freeness> {
  if (hasStatus) {
    if (activity === 'idle') return 'idle';
    if (activity === 'busy') return 'busy';
    if (activity === 'waiting') return 'waiting';
    return 'unknown';
  }
  if (follower === null || launchedAt === null) return 'unknown';
  await follower.poll().catch(() => null);
  if (follower.hasOpenTurn?.(launchedAt) === true || follower.hasOpenToolCall(launchedAt)) return 'busy';
  return 'idle';
}

export async function deliverScheduled(deps: ScheduledDeliveryDeps, request: ScheduledDeliveryRequest): Promise<ScheduledDeliveryOutcome> {
  const { terminalId, text, support } = request;
  const pollMs = request.pollMs ?? SCHEDULED_POLL_MS;
  const first = deps.tab(terminalId);
  if (first === null) return { kind: 'gone' };
  if (!first.alive || first.sessionId.length === 0) return { kind: 'not-ready' };
  const target = { cwd: first.cwd, sessionId: first.sessionId };
  const follower = deps.follow(target);
  await follower.start();
  // Lo que ya estaba: desde aca, lo que llegue es nuevo.
  await follower.poll().catch(() => null);

  // 1. Libre y lista.
  const screen = support.kind === 'screen' ? deps.screen(terminalId) : null;
  if (support.kind === 'screen' && screen === null) return { kind: 'not-ready' };
  try {
    const deadline = deps.now() + request.readyTimeoutMs;
    let previous: string | null = null;
    let last: Freeness = 'unknown';
    for (;;) {
      const tab = deps.tab(terminalId);
      if (tab === null) return { kind: 'gone' };
      // Sin proceso, o la pestana cambio de conversacion: no se escribe.
      if (!tab.alive || tab.sessionId !== target.sessionId) return { kind: 'not-ready' };
      last = await freenessOf(request.hasStatus, deps.activityOf(terminalId), follower, tab.launchedAt);
      if (last === 'idle') {
        if (screen === null) break;
        const lines = await screen.lines();
        const key = lines.join('\n');
        if (support.kind === 'screen' && support.readyScreen(lines)) {
          if (key === previous) break;
          previous = key;
        } else {
          previous = null;
        }
      } else {
        previous = null;
      }
      if (deps.now() >= deadline) return last === 'busy' || last === 'waiting' ? { kind: 'busy' } : { kind: 'not-ready' };
      await deps.wait(pollMs);
    }
  } finally {
    screen?.dispose();
  }

  // 2. Escribirlo.
  const writtenAt = deps.now();
  if (support.kind === 'api') {
    const outcome = await support.deliver(target, text).catch(() => 'failed' as const);
    if (outcome === 'not-sent') return { kind: 'not-ready' };
    // `failed`: no se sabe si lo tomo; la confirmacion lo dice.
  } else {
    const result = await deps.submit(terminalId, text);
    switch (result.kind) {
      case 'written':
        break;
      case 'refusal':
      case 'prepare-failed':
      case 'dropped':
        // Nada escrito.
        return { kind: 'not-ready' };
      case 'nothing':
        return { kind: 'nothing' };
      case 'cli-draft':
        return { kind: 'cli-draft' };
      case 'refused':
        return { kind: 'refused' };
      case 'blocked':
      case 'interrupted':
      case 'failed':
        // Pudo quedar a medias en la caja de la CLI.
        return { kind: 'interrupted' };
    }
  }

  // 3. Verlo llegar.
  const confirmDeadline = deps.now() + support.confirmTimeoutMs;
  for (;;) {
    const read = await follower.poll().catch(() => null);
    if (
      read !== null &&
      read.added.some((event) => (event.at === 0 || event.at >= writtenAt - 5_000) && isUserMessageWith(event, text))
    ) {
      return { kind: 'sent' };
    }
    // Se escribio con la CLI libre: si ahora trabaja, es por este mensaje.
    if (request.hasStatus && deps.activityOf(terminalId) === 'busy') return { kind: 'sent' };
    if (deps.now() >= confirmDeadline) return { kind: 'unconfirmed' };
    await deps.wait(pollMs);
  }
}
