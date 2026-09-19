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

import type { AgentId, ProjectSummary, SessionAgentId } from '@agent-workbench/shared';
import { t } from './i18n/index.js';

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
 *
 * `agentId` puede ser una fuente importada a la copia propia (hito 28): sus
 * filas se archivan igual que las de una CLI.
 */
export function sessionsToArchiveBefore(
  projects: readonly ProjectSummary[],
  agentId: SessionAgentId,
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
  agent: SessionAgentId;
  count: number;
}

/**
 * Cuantas se archivarian por CLI, solo las que tienen alguna.
 *
 * En el orden de `agentOrder` —la lista de CLIs del `hello`—, no en el que
 * aparecen en el historial: los proyectos se ordenan por actividad, y con eso
 * las filas se reacomodarian solas cada vez que otro proyecto tiene la ultima
 * palabra. Una CLI que no esta en la lista (el historial de una que ya no se
 * anuncia, o una fuente importada, que no se anuncia nunca) va al final, en
 * orden de aparicion.
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
  const agents: SessionAgentId[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!agents.includes(session.agent)) agents.push(session.agent);
    }
  }
  const order: readonly SessionAgentId[] = agentOrder;
  const rank = (agent: SessionAgentId): number => {
    const index = order.indexOf(agent);
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

/** Que pasaria al archivar un proyecto entero (hito 31). */
export interface ProjectArchivePlan {
  /** Los ids que se van a esconder. Vacio: no hay nada que archivar. */
  sessionIds: string[];
  /** Cuantas quedan afuera por tener una pestana abierta. */
  blocked: number;
}

/**
 * Las sesiones que esconderia "Archivar proyecto".
 *
 * Es el archivado de siempre —esconder, nunca borrar (CLAUDE.md 6.5)— aplicado
 * a todas las filas visibles de un proyecto de una vez. El caso que lo pide:
 * una carpeta de pruebas con veinte conversaciones se limpia con veinte
 * `Ctrl+clic`, o no se limpia.
 *
 * **No es un estado nuevo.** No se guarda que el proyecto este archivado: el
 * proyecto desaparece de la barra porque se queda sin sesiones visibles, y si
 * manana vuelve a tener una conversacion, vuelve a aparecer con esa sola fila.
 * Es lo que el usuario eligio frente a un archivado propio del proyecto, que
 * habria pedido un archivo mas, un mensaje mas del protocolo y una segunda
 * forma de restaurar.
 *
 * Las mismas dos reglas que `sessionsToArchiveBefore`, y por lo mismo:
 *
 * - **Las ya archivadas no cuentan**, ni para el numero ni para deshacer: si
 *   contaran, "Deshacer" restauraria filas que el usuario habia escondido a
 *   proposito antes.
 * - **Las que tienen pestana abierta quedan afuera**, porque el servidor
 *   tampoco las archiva. Se cuentan aparte para poder decirlo en vez de
 *   prometer un numero que no se cumple.
 */
export function projectArchivePlan(
  project: Pick<ProjectSummary, 'sessions'>,
  openSessionIds: ReadonlySet<string>,
): ProjectArchivePlan {
  const sessionIds = new Set<string>();
  let blocked = 0;
  for (const session of project.sessions) {
    if (session.archived) continue;
    if (openSessionIds.has(session.sessionId)) {
      blocked += 1;
      continue;
    }
    sessionIds.add(session.sessionId);
  }
  return { sessionIds: [...sessionIds], blocked };
}

/**
 * Lo que dice la fila de confirmacion.
 *
 * Confirma en el sitio, como "Archivar historial" y por lo mismo: esconde de
 * una vez todo lo que se ve de un proyecto, y el boton aparece al pasar el
 * mouse, que es justo donde el mouse pasa sin querer.
 */
export function projectArchiveText(plan: ProjectArchivePlan): string {
  const { sessionIds, blocked } = plan;
  if (sessionIds.length === 0) return t('archive.allBlocked', { count: blocked });
  const confirm = t('archive.confirm', { count: sessionIds.length });
  if (blocked === 0) return confirm;
  return t('archive.withBlocked', { confirm, blocked: t('archive.blockedStays', { count: blocked }) });
}
