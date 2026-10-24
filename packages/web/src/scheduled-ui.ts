/**
 * Lo puro de los mensajes programados en la web (hito 51, §6.39): los atajos del
 * menu del reloj, la hora elegida a mano, que dice cada mensaje y que se avisa
 * antes de cerrar una pestana. Lo prueba `check-scheduled-messages.mjs`.
 *
 * Las horas son las de la ventana: el navegador sabe en que zona esta, y el
 * servidor recibe milisegundos desde 1970, que no tienen zona.
 */

import { MAX_SCHEDULE_AHEAD_MS, type ScheduledMessage, type TerminalId } from '@agent-workbench/shared';
import { formatDayTime, formatTimeLeft } from './i18n/format.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';

const HOUR_MS = 60 * 60 * 1000;

/** Un atajo del menu: dentro de una hora, o manana a las 9. */
export interface QuickSchedule {
  id: 'in-hour' | 'tomorrow-morning';
  at: number;
}

/** Los atajos de ahora. "En una hora" va al minuto: sin segundos. */
export function quickSchedules(now: number): QuickSchedule[] {
  const inHour = new Date(now + HOUR_MS);
  inHour.setSeconds(0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { id: 'in-hour', at: inHour.getTime() },
    { id: 'tomorrow-morning', at: tomorrow.getTime() },
  ];
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** El valor de un `<input type="date">` para ese momento, en la hora de la ventana. */
export function dateInputValue(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

/** El valor de un `<input type="time">` para ese momento, en la hora de la ventana. */
export function timeInputValue(at: number): string {
  const date = new Date(at);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** Lo que el menu propone para elegir a mano: manana a las 9. */
export function customDefaults(now: number): { date: string; time: string } {
  const tomorrow = quickSchedules(now)[1]?.at ?? now + 24 * HOUR_MS;
  return { date: dateInputValue(tomorrow), time: timeInputValue(tomorrow) };
}

/** Los topes del selector de dia: de hoy hasta donde se puede programar. */
export function dateInputBounds(now: number): { min: string; max: string } {
  return { min: dateInputValue(now), max: dateInputValue(now + MAX_SCHEDULE_AHEAD_MS) };
}

/** El momento de un dia y una hora elegidos a mano, en la hora de la ventana, o null si no se entienden. */
export function customScheduleAt(date: string, time: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (day === null || clock === null) return null;
  const [year, month, dayOfMonth] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31 || hours > 23 || minutes > 59) return null;
  const at = new Date(year, month - 1, dayOfMonth, hours, minutes, 0, 0);
  // `Date` corre el 31 de febrero al 3 de marzo: eso no es lo que se eligio.
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== dayOfMonth) return null;
  return at.getTime();
}

/** Por que no se puede programar a esa hora, para el menu, o null. El servidor lo vuelve a mirar. */
export function scheduleTimeHint(at: number | null, now: number): string | null {
  if (at === null) return t('scheduled.menu.invalid');
  if (at <= now) return t('scheduled.menu.past');
  if (at - now > MAX_SCHEDULE_AHEAD_MS) return t('scheduled.menu.tooFar', { days: Math.round(MAX_SCHEDULE_AHEAD_MS / 86_400_000) });
  return null;
}

/** La hora de un mensaje, con cuanto falta: `mar 28 oct, 10:00 (en 3d 2h)`. */
export function scheduledWhen(sendAt: number, now: number): string {
  const when = formatDayTime(sendAt);
  return sendAt > now ? t('scheduled.when.ahead', { when, left: formatTimeLeft(sendAt - now) }) : when;
}

/** Lo que dice un mensaje programado de si mismo, al pie de su burbuja. */
export function scheduledStateText(message: ScheduledMessage, now: number): string {
  switch (message.state) {
    case 'scheduled':
      return t('scheduled.state.scheduled', { when: scheduledWhen(message.sendAt, now) });
    case 'waiting':
      return message.note === null ? t('scheduled.state.due') : serverTextMessage(message.note);
    case 'sending':
      return t('scheduled.state.sending');
    case 'paused':
      return t('scheduled.state.paused', { when: formatDayTime(message.sendAt) });
    case 'failed':
      return message.note === null ? t('scheduled.state.failed') : serverTextMessage(message.note);
  }
}

/** Los de una pestana, en orden de hora. */
export function scheduledFor(messages: readonly ScheduledMessage[] | null, terminalId: TerminalId | null): ScheduledMessage[] {
  if (messages === null || terminalId === null) return [];
  return messages.filter((message) => message.terminalId === terminalId).sort((a, b) => a.sendAt - b.sendAt);
}

/**
 * La linea del titulo de una pestana con algo programado, o null. Dice el
 * proximo, y si alguno no se envio, eso primero: es lo que hay que mirar.
 */
export function scheduledTabLine(messages: readonly ScheduledMessage[]): string | null {
  if (messages.length === 0) return null;
  const failed = messages.filter((message) => message.state === 'failed').length;
  if (failed > 0) return t('scheduled.tab.failed', { count: failed });
  const next = messages[0];
  if (next === undefined) return null;
  return t('scheduled.tab.next', { count: messages.length, when: formatDayTime(next.sendAt) });
}

/** true si alguno de la pestana no se envio: el reloj de la pestana va en el color de aviso. */
export function scheduledTabFailed(messages: readonly ScheduledMessage[]): boolean {
  return messages.some((message) => message.state === 'failed');
}

/** Lo que pregunta la × de una pestana con algo programado antes de cerrarla, o null si no hay nada que avisar. */
export function scheduledCloseWarning(messages: readonly ScheduledMessage[]): string | null {
  const pending = messages.filter((message) => message.state !== 'failed');
  const first = pending[0];
  if (first === undefined) return null;
  return t('scheduled.close.warning', { count: pending.length, when: formatDayTime(first.sendAt) });
}

/** true si se puede sacar o mandar ya: mientras se manda, no. */
export function scheduledActionable(message: ScheduledMessage): boolean {
  return message.state !== 'sending';
}
