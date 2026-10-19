/**
 * Los limites del plan de la cuenta (hito 47, §6.37): cuanto se uso de cada
 * ventana (las 5 horas, la semana) y cuando se reinicia.
 *
 * No es un dato de la pestana sino de la cuenta de cada CLI: el servidor junta
 * lo ultimo que vio de cada una y lo manda a todas las ventanas
 * (`plan.limits`). Sale solo de lo que la CLI ya deja a mano, su historial o su
 * status line: la app no le pregunta nada al proveedor (CLAUDE.md 2.4) ni toca
 * la credencial de la cuenta (2.1).
 *
 * Porcentaje y reinicio, nunca dinero (regla 1 de `ContextMeter.tsx`).
 */

import { AGENT_IDS, type AgentId } from './agents.js';
import { asArrayFiltered, asFiniteNumber, asLiteral, asRecord } from './validation.js';

/** Cuanto duran las ventanas que se conocen, en minutos. */
export const PLAN_WINDOW_MINUTES = {
  fiveHours: 300,
  day: 1_440,
  week: 10_080,
  month: 43_200,
} as const;

/** Mas ventanas que esto por CLI no se guardan ni viajan: ninguna CLI publica tantas. */
export const MAX_PLAN_LIMIT_WINDOWS = 8;

/** Lo que identifica una ventana dentro de su CLI. Corto y sin espacios. */
export const PLAN_LIMIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export interface PlanLimitWindow {
  /**
   * Que ventana es, dentro de su CLI: `five_hour`, `seven_day`, `300m`, el
   * nombre de una cuota. Es lo que junta lo que dicen dos sesiones de la misma.
   */
  id: string;
  /** Cuanto dura, en minutos, o null si la CLI no lo dice. */
  minutes: number | null;
  /** Lo usado, de 0 a 100. Puede pasar de 100 con el limite alcanzado. */
  usedPercent: number;
  /** Cuando se reinicia (epoch ms), o null si no se sabe. */
  resetsAt: number | null;
  /**
   * Desde cuando se ve este valor (epoch ms). Entre dos sesiones gana el mas
   * nuevo: una sesion quieta vuelve a publicar lo que vio hace una hora, y eso
   * no puede pisar lo que otra acaba de medir.
   */
  observedAt: number;
}

/** Lo que se sabe de los limites de una CLI. */
export interface PlanLimits {
  agent: AgentId;
  windows: PlanLimitWindow[];
}

/** Una ventana, o null si le falta algo o no tiene la forma. */
export function parsePlanLimitWindow(value: unknown): PlanLimitWindow | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record['id'];
  if (typeof id !== 'string' || !PLAN_LIMIT_ID_PATTERN.test(id)) return null;
  const usedPercent = asFiniteNumber(record['usedPercent']);
  const observedAt = asFiniteNumber(record['observedAt']);
  if (usedPercent === null || usedPercent < 0 || observedAt === null || observedAt <= 0) return null;
  const rawMinutes = record['minutes'];
  const minutes = rawMinutes === null ? null : asFiniteNumber(rawMinutes);
  if (rawMinutes !== null && (minutes === null || minutes <= 0)) return null;
  const rawResets = record['resetsAt'];
  const resetsAt = rawResets === null ? null : asFiniteNumber(rawResets);
  if (rawResets !== null && (resetsAt === null || resetsAt <= 0)) return null;
  return { id, minutes, usedPercent, resetsAt, observedAt };
}

/** Las ventanas de una lista, sin las que no se entienden, con tope. null si no es una lista. */
export function parsePlanLimitWindows(value: unknown): PlanLimitWindow[] | null {
  return asArrayFiltered(value, parsePlanLimitWindow)?.slice(0, MAX_PLAN_LIMIT_WINDOWS) ?? null;
}

/** Los limites de una CLI, o null si la CLI no es una que este lado conozca. */
export function parsePlanLimits(value: unknown): PlanLimits | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], AGENT_IDS);
  const windows = parsePlanLimitWindows(record['windows']);
  if (agent === null || windows === null) return null;
  return { agent, windows };
}

/**
 * Dos lecturas de la misma ventana pueden dar el reinicio con unos segundos de
 * diferencia (Codex y Antigravity a veces lo dan en segundos relativos); dos
 * ventanas distintas del mismo id, por lo menos la duracion de una.
 */
export const SAME_PLAN_WINDOW_SLACK_MS = 10 * 60 * 1000;

/**
 * true si `candidate` dice algo mas actual que `known` del mismo id. La hora en
 * que se observo no alcanza: una status line vuelve a correr en una sesion
 * quieta (al recargar la configuracion, al cambiar de modo) y presenta lo que
 * vio hace horas como recien medido. Decide el reinicio, porque una ventana
 * posterior es mas nueva, y dentro de la misma ventana el uso mayor, porque ahi
 * el uso solo sube. La hora decide sin reinicio en alguna de las dos, o con el
 * mismo uso.
 */
function isNewerPlanReading(known: PlanLimitWindow, candidate: PlanLimitWindow): boolean {
  if (known.resetsAt !== null && candidate.resetsAt !== null) {
    if (Math.abs(candidate.resetsAt - known.resetsAt) > SAME_PLAN_WINDOW_SLACK_MS) {
      return candidate.resetsAt > known.resetsAt;
    }
    if (candidate.usedPercent !== known.usedPercent) return candidate.usedPercent > known.usedPercent;
    return candidate.observedAt > known.observedAt;
  }
  return (
    candidate.observedAt > known.observedAt ||
    (candidate.observedAt === known.observedAt && candidate.usedPercent > known.usedPercent)
  );
}

/**
 * Junta lo que se sabia con lo nuevo: por ventana, la lectura mas actual
 * (`isNewerPlanReading`). Ordenadas de la mas corta a la mas larga, las sin
 * duracion al final, y con tope. No descarta las vencidas: eso depende de la
 * hora a la que se miren.
 */
export function mergePlanLimitWindows(
  current: readonly PlanLimitWindow[],
  incoming: readonly PlanLimitWindow[],
): PlanLimitWindow[] {
  const byId = new Map<string, PlanLimitWindow>();
  for (const window of [...current, ...incoming]) {
    const known = byId.get(window.id);
    if (known === undefined || isNewerPlanReading(known, window)) byId.set(window.id, window);
  }
  return [...byId.values()].sort(byLength).slice(0, MAX_PLAN_LIMIT_WINDOWS);
}

/** Las que siguen en pie a la hora `now`: una ventana que ya se reinicio no dice nada. */
export function livePlanWindows(windows: readonly PlanLimitWindow[], now: number): PlanLimitWindow[] {
  return windows.filter((window) => window.resetsAt === null || window.resetsAt > now);
}

/** true si dos listas dicen lo mismo: el servidor no avisa un cambio que no cambio nada. */
export function samePlanWindows(a: readonly PlanLimitWindow[], b: readonly PlanLimitWindow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((window, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      window.id === other.id &&
      window.minutes === other.minutes &&
      window.usedPercent === other.usedPercent &&
      window.resetsAt === other.resetsAt &&
      window.observedAt === other.observedAt
    );
  });
}

function byLength(a: PlanLimitWindow, b: PlanLimitWindow): number {
  if (a.minutes === b.minutes) return a.id.localeCompare(b.id);
  if (a.minutes === null) return 1;
  if (b.minutes === null) return -1;
  return a.minutes - b.minutes;
}
