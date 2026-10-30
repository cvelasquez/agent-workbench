/**
 * Por qué no se puede pasar ahora la conversación de una pestaña a una rama
 * aparte (`WorktreeServiceDeps.moveBlocker`, §6.38): pasarla cierra su CLI, y
 * eso cortaría lo que el agente hace.
 *
 * Lo del Hito 54 es el estado que publica la CLI y lo que espera al agente
 * (`worktreeMoveBlock`). Con la CLI que no publica su estado (Codex, hito 55)
 * eso nunca frena: trabaja si su historial tiene un turno o una herramienta
 * abiertos desde que se lanzó, como lo mira el reloj de los mensajes
 * programados (`freenessOf`, §6.39).
 */

import { worktreeMoveBlock, type TerminalActivity, type WorktreeMoveBlock } from '@agent-workbench/shared';
import type { SessionFollower } from '../agents/adapter.js';
import { freenessOf } from '../scheduled-messages/delivery.js';

export interface MoveBlockInput {
  activity: TerminalActivity | null;
  /** Algo espera al agente: lo enviado que no empezó, o la cola. */
  pending: boolean;
  /**
   * Con la CLI que no publica su estado y tiene la pestaña abierta: cómo
   * seguir su conversación y cuándo se lanzó. null en los demás casos.
   */
  history: { follow: () => SessionFollower; launchedAt: number } | null;
}

export async function moveBlockNow(input: MoveBlockInput): Promise<WorktreeMoveBlock | null> {
  const block = worktreeMoveBlock(input.activity, input.pending);
  if (block !== null || input.history === null) return block;
  const follower = input.history.follow();
  try {
    await follower.start();
    return (await freenessOf(false, null, follower, input.history.launchedAt)) === 'busy' ? 'busy' : null;
  } finally {
    await follower.close?.().catch(() => undefined);
  }
}
