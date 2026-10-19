/**
 * Que muestra el medidor del plan (hito 47, §6.37), sin React: lo prueba el
 * chequeo.
 *
 * Tres reglas, las tres pedidas por el usuario el 19-10-2026:
 *
 *  1. **Las dos ventanas si hay sitio**: las 5 horas y la semana. Con mas de dos
 *     (una CLI con varias cuotas), las dos mas cortas.
 *  2. **Si solo cabe una, la de 5 horas** (la mas corta), y el titulo dice
 *     todas. Salvo que otra este al 90 % o mas y la corta no: esa es la que
 *     esta por frenar el trabajo, y esconderla seria esconder justo el aviso.
 *  3. **Al 90 % o mas, el numero en rojo.** La barra usa los umbrales del
 *     medidor de contexto (75 y 90).
 *
 * Una ventana que ya se reinicio no se muestra: la CLI tampoco la publica.
 */

import {
  PLAN_WINDOW_MINUTES,
  livePlanWindows,
  type PlanLimitWindow,
  type StatusLineState,
} from '@agent-workbench/shared';
import { formatDate, formatPercent, formatTime, formatTimeLeft, formatWeekdayTime, formatWhen } from './i18n/format.js';
import { t, type MessageKey } from './i18n/index.js';

/** Desde aca la barra se pone amarilla. El mismo que el medidor de contexto. */
export const PLAN_WARN_PERCENT = 75;
/** Desde aca la barra y el numero se ponen rojos. */
export const PLAN_DANGER_PERCENT = 90;

/** Cada cuanto se redibuja el medidor sin datos nuevos: el tiempo que falta corre solo. */
export const PLAN_METER_TICK_MS = 30_000;

export type PlanLevel = 'ok' | 'warn' | 'danger';

export function planLevel(usedPercent: number): PlanLevel {
  if (usedPercent >= PLAN_DANGER_PERCENT) return 'danger';
  if (usedPercent >= PLAN_WARN_PERCENT) return 'warn';
  return 'ok';
}

export interface PlanMeterView {
  /** Las que se dibujan, de la mas corta a la mas larga: una o dos. */
  shown: PlanLimitWindow[];
  /** La que queda cuando solo cabe una (regla 2). */
  priorityId: string;
  /** Todas las vigentes, para el titulo. */
  all: PlanLimitWindow[];
}

function byLength(a: PlanLimitWindow, b: PlanLimitWindow): number {
  if (a.minutes === b.minutes) return a.id.localeCompare(b.id);
  if (a.minutes === null) return 1;
  if (b.minutes === null) return -1;
  return a.minutes - b.minutes;
}

/**
 * Que ventanas dibujar a la hora `now`, o null si no hay ninguna vigente. Dos
 * ventanas de la misma duracion (dos cuotas semanales) ocupan un solo lugar: el
 * de la mas usada.
 */
export function planMeterView(windows: readonly PlanLimitWindow[], now: number): PlanMeterView | null {
  const all = livePlanWindows(windows, now).sort(byLength);
  if (all.length === 0) return null;

  const byLengthSlot = new Map<string, PlanLimitWindow>();
  for (const window of all) {
    const slot = window.minutes === null ? `id:${window.id}` : `m:${window.minutes}`;
    const known = byLengthSlot.get(slot);
    if (known === undefined || window.usedPercent > known.usedPercent) byLengthSlot.set(slot, window);
  }
  const distinct = [...byLengthSlot.values()].sort(byLength);
  const first = distinct[0];
  if (first === undefined) return null;

  const pressing = distinct.find((window) => window.usedPercent >= PLAN_DANGER_PERCENT);
  const priority = first.usedPercent < PLAN_DANGER_PERCENT && pressing !== undefined ? pressing : first;

  let shown = distinct.slice(0, 2);
  if (!shown.includes(priority)) shown = [first, priority];
  return { shown: shown.sort(byLength), priorityId: priority.id, all };
}

/** El nombre corto de una ventana: `5h`, `Semana`, `Mes`, `3d`, o `Cuota` si no se sabe cuanto dura. */
export function planWindowLabel(window: Pick<PlanLimitWindow, 'minutes'>): string {
  const { minutes } = window;
  if (minutes === null) return t('plan.window.quota');
  if (minutes === PLAN_WINDOW_MINUTES.fiveHours) return t('plan.window.fiveHours');
  if (minutes === PLAN_WINDOW_MINUTES.day) return t('plan.window.day');
  if (minutes === PLAN_WINDOW_MINUTES.week) return t('plan.window.week');
  // Un mes de Codex son 43 200 minutos: 30 dias justos. Se acepta algo de holgura.
  if (Math.abs(minutes - PLAN_WINDOW_MINUTES.month) <= PLAN_WINDOW_MINUTES.day) return t('plan.window.month');
  if (minutes % PLAN_WINDOW_MINUTES.day === 0) return t('plan.window.days', { value: minutes / PLAN_WINDOW_MINUTES.day });
  return t('plan.window.hours', { value: Math.max(1, Math.round(minutes / 60)) });
}

/**
 * El porcentaje que se escribe. Nunca 100 % antes de llegar: con 99,6 la
 * ventana todavia deja trabajar, y un redondeo hacia arriba diria que no.
 */
export function planPercentText(usedPercent: number): string {
  const shown = usedPercent >= 100 ? Math.round(usedPercent) : Math.min(99, Math.round(usedPercent));
  return formatPercent(shown);
}

/** Cuanto falta para el reinicio, o null si no se sabe. */
export function planTimeLeftText(window: Pick<PlanLimitWindow, 'resetsAt'>, now: number): string | null {
  return window.resetsAt === null ? null : formatTimeLeft(window.resetsAt - now);
}

/** Cuando se reinicia, con la forma que le corresponde a lo que falta. */
function resetMoment(resetsAt: number, now: number): string {
  if (resetsAt - now < 24 * 60 * 60 * 1000) return formatTime(resetsAt);
  if (resetsAt - now < 7 * 24 * 60 * 60 * 1000) return formatWeekdayTime(resetsAt);
  return `${formatDate(resetsAt)} ${formatTime(resetsAt)}`;
}

/** El titulo del medidor: una linea por ventana vigente, y cuando llego el ultimo dato. */
export function planMeterTitle(view: PlanMeterView, now: number): string {
  const lines = view.all.map((window) => {
    const used = t('plan.used', { percent: planPercentText(window.usedPercent) });
    const reset =
      window.resetsAt === null
        ? t('plan.noReset')
        : t('plan.resetsIn', { time: formatTimeLeft(window.resetsAt - now), at: resetMoment(window.resetsAt, now) });
    return `${planWindowLabel(window)}: ${used} · ${reset}`;
  });
  const newest = Math.max(...view.all.map((window) => window.observedAt));
  lines.push(t('plan.observed', { when: formatWhen(newest, now) }));
  return lines.join('\n');
}

const SETUP_TITLE_KEYS: Readonly<Record<Exclude<StatusLineState, 'active'>, MessageKey>> = {
  missing: 'plan.setup.missing',
  'other-command': 'plan.setup.otherCommand',
  disabled: 'plan.setup.disabled',
  unreadable: 'plan.setup.unreadable',
};

/**
 * Que dice el medidor sin ventanas vigentes, segun como este la status line que
 * las publica:
 *
 *  - `configure`: no esta puesta; se ofrece el dialogo.
 *  - `waiting`: esta puesta y todavia no publico nada (antes de la primera
 *    respuesta, o una cuenta sin plan).
 *  - `hidden`: la CLI no tiene status line que configurar: sin datos, nada.
 */
export type PlanIdleState = 'configure' | 'waiting' | 'hidden';

export function planIdleState(setupState: StatusLineState | null): PlanIdleState {
  if (setupState === null) return 'hidden';
  return setupState === 'active' ? 'waiting' : 'configure';
}

/** El titulo del medidor cuando ofrece configurar. */
export function planSetupTitle(state: StatusLineState): string {
  return state === 'active' ? t('plan.noDataTitle') : t(SETUP_TITLE_KEYS[state]);
}
