/**
 * El reloj chico de una pestana con algo programado (hito 51, §6.39), en la
 * barra de pestanas y en la lista del telefono. En el color de aviso si alguno
 * no se envio: es lo que hay que ir a mirar. El texto lo lleva el titulo de la
 * pestana; aca solo el dibujo.
 */

import type { ScheduledMessage } from '@agent-workbench/shared';
import { scheduledTabFailed } from './scheduled-ui.js';

export function ScheduledClock({ messages }: { messages: readonly ScheduledMessage[] }): JSX.Element {
  return (
    <span className={`tab-scheduled${scheduledTabFailed(messages) ? ' tab-scheduled-failed' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="11" height="11">
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
