/**
 * Leer una sesion entera por el seguidor de su adaptador (hito 28, D3).
 *
 * La copia no conoce ningun formato nativo: le pide a `history.follow` la
 * sesion con sus topes (`FollowOptions`) y sin tope de eventos, lee hasta que
 * no queda nada nuevo y se lleva la cola completa. Es exactamente el camino del
 * hilo, con otros numeros; por eso un mapeo nuevo de un adaptador llega a la
 * copia sin tocar nada aca.
 *
 * Dos cosas que no se pueden detectar despues y por eso se comprueban aca:
 *
 *  - **Una fuente que no declara `wholeRead` no se lee.** Su seguidor puede
 *    ignorar las opciones y entregar los textos a los topes de transporte; la
 *    copia guardaria eso como si fuera la sesion entera, sin que nada lo delate
 *    (C7). Lanza `UnsupportedHistoryError`.
 *  - **Una lectura que pagina lanza.** Con `maxEvents` infinito, `hasMore` solo
 *    puede significar que el seguidor no respeto el tope: la sesion quedaria
 *    sin su principio (R6).
 *
 * No hay `dispose` en `SessionFollower`: el seguidor no abre nada persistente
 * salvo la conexion de OpenCode, que se cierra sola (`agents/sqlite.ts`).
 */

import type { ContextUsage, ConversationEvent, ConversationImageSource } from '@agent-workbench/shared';
import type { HistorySource, LoadedImage, SessionFollower } from '../agents/adapter.js';
import type { EventLimits } from '../agents/transport-limits.js';

/** Lecturas seguidas sin novedades que alcanzan para dar la sesion por leida. */
const MAX_POLLS = 5;
/** Tope duro, por si la sesion se reemplaza una y otra vez mientras se lee. */
const MAX_TOTAL_POLLS = 20;

export class UnsupportedHistoryError extends Error {
  constructor(label: string) {
    super(`${label}: the source doesn't declare that its follower respects the local copy's limits (wholeRead)`);
    this.name = 'UnsupportedHistoryError';
  }
}

export class PagedHistoryError extends Error {
  constructor(label: string, events: number) {
    super(`${label}: the follower paged with infinite maxEvents (${events} ${events === 1 ? 'event' : 'events'} and more left)`);
    this.name = 'PagedHistoryError';
  }
}

export interface WholeSession {
  /**
   * `live`: se leyo. `no-transcript`: la conversacion existe pero su CLI no
   * dejo nada legible (Antigravity viejo); sale sin eventos, y no es "no se
   * encontro el origen" (C6), que es null.
   */
  state: 'live' | 'no-transcript';
  events: readonly ConversationEvent[];
  usage: ContextUsage;
  /** Etiqueta del seguidor, para los logs de quien escribe. */
  label: string;
  readImage(eventId: string, index: number, source: ConversationImageSource): Promise<LoadedImage | null>;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * `start()` y `poll()` hasta que una lectura, despues de la primera, no trae
 * nada; un `reset` vuelve a contar, y hay un tope duro de lecturas. Entre dos
 * lecturas se cede el turno: esto corre en el proceso que reenvia las pty.
 *
 * Lo comparten la copia (`readWholeSession`) y la continuacion en otra CLI
 * (hito 29), que lee con otro tope de eventos. Lanza si el seguidor lanza.
 */
export async function drainFollower(follower: SessionFollower): Promise<void> {
  await follower.start();

  let budget = MAX_POLLS;
  for (let total = 1; ; total += 1) {
    const result = await follower.poll();
    const quiet = !result.reset && result.added.length === 0;
    if (result.reset) {
      budget = MAX_POLLS;
    } else if (quiet && total > 1 && follower.getState() !== 'waiting') {
      break;
    }
    budget -= 1;
    if (budget <= 0 || total >= MAX_TOTAL_POLLS) break;
    await nextTurn();
  }
}

/**
 * La sesion entera, con `limits`, en una pasada.
 *
 * null si el origen no se encontro: el seguidor no llego a `live` (archivo
 * ausente, `cwd` vacio, base sin esa sesion). Lanza si el seguidor lanza, si la
 * fuente no declara `wholeRead`, o si la lectura pagina.
 *
 * Algoritmo: `start()` —Codex busca ahi su rollout— y `poll()` hasta que una
 * lectura, despues de la primera, no trae nada; un `reset` vuelve a contar.
 * Entre dos lecturas se cede el turno: esto corre en el proceso que reenvia las
 * pty.
 */
export async function readWholeSession(
  history: HistorySource,
  target: { cwd: string; sessionId: string },
  limits: EventLimits,
): Promise<WholeSession | null> {
  if (history.wholeRead !== true) throw new UnsupportedHistoryError(target.sessionId);

  const follower = history.follow(target, { limits, maxEvents: Number.POSITIVE_INFINITY });
  await drainFollower(follower);

  const state = follower.getState();
  if (state !== 'live' && state !== 'no-transcript') return null;

  const page = follower.getTail(Number.MAX_SAFE_INTEGER);
  if (page.hasMore) throw new PagedHistoryError(follower.label, page.events.length);

  return {
    state,
    events: page.events,
    usage: follower.getUsage(),
    label: follower.label,
    readImage: (eventId, index, source) => follower.readImage(eventId, index, source),
  };
}
