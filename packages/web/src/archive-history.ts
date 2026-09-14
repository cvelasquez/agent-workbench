/**
 * Que sesiones esconde "Archivar historial": las de una CLI anteriores a hoy.
 *
 * El caso que la motiva es historial duplicado, no desorden: quien migro sus
 * conversaciones viejas de una CLI a otra las ve dos veces en la barra, y
 * archivarlas de a una con `Ctrl+clic` son cientos de clics. Es el mismo
 * archivado de siempre (CLAUDE.md 6.5) —esconder, nunca borrar— con una
 * forma de elegir de a muchas.
 *
 * Sin JSX, para que lo pruebe el chequeo.
 */

import type { AgentId, ProjectSummary } from '@agent-workbench/shared';

/**
 * La medianoche local del dia de `nowMs`.
 *
 * Local y no UTC: "anterior a hoy" es el hoy del usuario. Con la hora de la
 * maquina en UTC-5, un corte a medianoche UTC dejaria afuera lo de la noche
 * anterior a partir de las siete de la tarde. Y con `setHours` y no restando
 * `getTimezoneOffset`: el dia del cambio de hora, el desfase de mediodia no es
 * el de medianoche.
 */
export function startOfLocalDay(nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Los ids de las sesiones de `agentId` que se archivarian con este corte.
 *
 * - Solo las que todavia se ven: una archivada ya esta escondida.
 * - Solo las de antes del corte, estricto: lo de hoy, incluida la de las 00:00
 *   en punto, es lo que uno esta usando.
 * - Sin las que tienen pestana abierta, la misma regla que `canArchive` de la
 *   barra: el servidor tampoco las archiva, y contarlas prometeria un numero
 *   que no se cumple.
 * - Sin repetidos. El archivo guarda ids a secas (CLAUDE.md 6.5), y un id que
 *   apareciera en dos proyectos contaria dos veces una sola sesion.
 */
export function sessionsToArchiveBefore(
  projects: readonly ProjectSummary[],
  agentId: AgentId,
  cutoffMs: number,
  openSessionIds: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.agent !== agentId) continue;
      if (session.archived) continue;
      if (!(session.updatedAt < cutoffMs)) continue;
      if (openSessionIds.has(session.sessionId)) continue;
      found.add(session.sessionId);
    }
  }
  return [...found];
}

export interface ArchiveCandidates {
  agent: AgentId;
  count: number;
}

/**
 * Cuantas se archivarian por CLI, solo las que tienen alguna.
 *
 * En el orden de `agentOrder` —la lista de CLIs del `hello`—, no en el que
 * aparecen en el historial: los proyectos se ordenan por actividad, y con eso
 * las filas se reacomodarian solas cada vez que otro proyecto tiene la ultima
 * palabra. Una CLI que no esta en la lista (el historial de una que ya no se
 * anuncia) va al final, en orden de aparicion.
 *
 * Cuenta con `sessionsToArchiveBefore` y no por su lado: el numero que se
 * muestra tiene que ser exactamente el que se archiva al confirmar.
 */
export function archiveCandidatesByAgent(
  projects: readonly ProjectSummary[],
  cutoffMs: number,
  openSessionIds: ReadonlySet<string>,
  agentOrder: readonly AgentId[],
): ArchiveCandidates[] {
  const agents: AgentId[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!agents.includes(session.agent)) agents.push(session.agent);
    }
  }
  const rank = (agent: AgentId): number => {
    const index = agentOrder.indexOf(agent);
    return index === -1 ? agentOrder.length : index;
  };
  // `sort` es estable: las que empatan al final conservan el orden de aparicion.
  return agents
    .sort((a, b) => rank(a) - rank(b))
    .map((agent) => ({
      agent,
      count: sessionsToArchiveBefore(projects, agent, cutoffMs, openSessionIds).length,
    }))
    .filter((candidates) => candidates.count > 0);
}
