/**
 * El pedido de volver a antes de un mensaje (hito 44, §4.16): abre el dialogo,
 * manda `agent.rewind` y espera su respuesta, `agent.rewound` o un error con
 * el mismo `requestId`. El mensaje vuelve al cuadro por `composer.prefill` y el
 * hilo se rehace por `conversation.reset`: aca solo vive el dialogo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RewindRestore, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { serverTextMessage } from './i18n/server-text.js';

export interface RewindDialogState {
  terminalId: TerminalId;
  eventId: string;
  /** `confirm`: elegir. `running`: la app esta manejando el menu de la CLI. `failed`: no se pudo. */
  phase: 'confirm' | 'running' | 'failed';
  /** Por que no se pudo, ya en el idioma de la interfaz. */
  error: string | null;
}

export interface Rewind {
  state: RewindDialogState | null;
  open: (terminalId: TerminalId, eventId: string) => void;
  confirm: (restore: RewindRestore) => void;
  close: () => void;
}

export function useRewind(connection: AgentConnection): Rewind {
  const [state, setState] = useState<RewindDialogState | null>(null);
  const current = useRef<RewindDialogState | null>(null);
  const pending = useRef<string | null>(null);

  const update = useCallback((next: RewindDialogState | null) => {
    current.current = next;
    setState(next);
  }, []);

  useEffect(
    () =>
      connection.onMessage((message) => {
        const requestId = pending.current;
        if (requestId === null) return;
        if (message.type === 'agent.rewound' && message.requestId === requestId) {
          pending.current = null;
          update(null);
          return;
        }
        if (message.type === 'error' && message.requestId === requestId) {
          pending.current = null;
          const shown = current.current;
          if (shown !== null) update({ ...shown, phase: 'failed', error: serverTextMessage(message.text) });
        }
      }),
    [connection, update],
  );

  const open = useCallback(
    (terminalId: TerminalId, eventId: string) => {
      pending.current = null;
      update({ terminalId, eventId, phase: 'confirm', error: null });
    },
    [update],
  );

  const confirm = useCallback(
    (restore: RewindRestore) => {
      const shown = current.current;
      if (shown === null || shown.phase === 'running') return;
      const requestId = crypto.randomUUID();
      pending.current = requestId;
      connection.send({ type: 'agent.rewind', terminalId: shown.terminalId, eventId: shown.eventId, restore, requestId });
      update({ ...shown, phase: 'running', error: null });
    },
    [connection, update],
  );

  // Cerrar no corta nada: si ya se estaba haciendo, el mensaje igual vuelve al cuadro.
  const close = useCallback(() => {
    pending.current = null;
    update(null);
  }, [update]);

  return { state, open, confirm, close };
}
