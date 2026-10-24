/**
 * Los mensajes programados que tiene el servidor (hito 51, §6.39).
 *
 * La lista es una sola y la manda el servidor entera: al conectar y en cada
 * cambio (`schedule.list`). Un servidor anterior no la manda, y ahi `messages`
 * queda en null: la web no ofrece programar.
 *
 * Un pedido que el servidor no acepta llega como `schedule-failed`, y lo dice el
 * aviso de arriba como cualquier otro error: el texto de un mensaje que no se
 * pudo programar ya volvio al cuadro (`composer.prefill`, `unscheduled`).
 */

import { useCallback, useEffect, useState } from 'react';
import type { ScheduledMessage, ServerMessage, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { newSubmitRequestId } from './thread-status.js';

export interface ScheduledMessagesApi {
  /** null hasta la primera lista: un servidor anterior al hito 51. */
  messages: readonly ScheduledMessage[] | null;
  /** Programa lo escrito en el cuadro. true si salio por el socket en el acto. */
  schedule: (terminalId: TerminalId, text: string, sendAt: number) => boolean;
  /** Lo saca; su texto vuelve al cuadro. */
  cancel: (id: string) => void;
  /** Lo manda ya, con las reglas de siempre. */
  sendNow: (id: string) => void;
}

export function useScheduledMessages(connection: AgentConnection): ScheduledMessagesApi {
  const [messages, setMessages] = useState<readonly ScheduledMessage[] | null>(null);

  useEffect(
    () =>
      connection.onMessage((message: ServerMessage) => {
        if (message.type === 'schedule.list') setMessages(message.messages);
      }),
    [connection],
  );

  const schedule = useCallback(
    (terminalId: TerminalId, text: string, sendAt: number) =>
      connection.send({ type: 'schedule.create', requestId: newSubmitRequestId(), terminalId, text, sendAt }),
    [connection],
  );
  const cancel = useCallback((id: string) => void connection.send({ type: 'schedule.cancel', id }), [connection]);
  const sendNow = useCallback((id: string) => void connection.send({ type: 'schedule.sendNow', id }), [connection]);

  return { messages, schedule, cancel, sendNow };
}
