/**
 * Los planes que escribio la conversacion de la pestana visible.
 *
 * No pide nada al suscribirse: la lista llega sola con la conversacion
 * (`conversation.plans`), porque quien sabe que planes tiene una sesion es el
 * mismo que lee su JSONL. Lo unico que se pide es el **contenido**, y solo
 * cuando alguien abre uno — un plan son diez o quince KB de markdown y no hay
 * razon para traerlos todos por si acaso.
 *
 * Lo que viaja es el nombre del archivo que mando el servidor, nunca una ruta:
 * la carpeta la pone el, y comprueba que el plan sea de esta conversacion antes
 * de abrirlo.
 */

import { useCallback, useEffect, useState } from 'react';
import type { PlanContent, SessionPlan, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export interface PlansView {
  plans: SessionPlan[];
  /** El plan abierto, o null si se esta viendo la lista. */
  open: PlanContent | null;
  /** Nombre del que se pidio y todavia no llego. */
  loading: string | null;
  openPlan: (fileName: string) => void;
  closePlan: () => void;
}

export function usePlans(connection: AgentConnection, terminalId: TerminalId | null): PlansView {
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [open, setOpen] = useState<PlanContent | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    setPlans([]);
    setOpen(null);
    setLoading(null);
    if (terminalId === null) return;

    return connection.onMessage((message) => {
      switch (message.type) {
        case 'conversation.plans':
          if (message.terminalId !== terminalId) break;
          setPlans(message.plans);
          break;
        case 'plans.content':
          if (message.terminalId !== terminalId) break;
          setOpen(message.plan);
          setLoading(null);
          break;
        case 'error':
          // Un plan que no se pudo leer no puede dejar el panel diciendo
          // "abriendo" para siempre.
          setLoading(null);
          break;
        default:
          break;
      }
    });
  }, [connection, terminalId]);

  const openPlan = useCallback(
    (fileName: string) => {
      if (terminalId === null) return;
      setLoading(fileName);
      setOpen(null);
      connection.send({ type: 'plans.read', terminalId, fileName });
    },
    [connection, terminalId],
  );

  const closePlan = useCallback(() => {
    setOpen(null);
    setLoading(null);
  }, []);

  return { plans, open, loading, openPlan, closePlan };
}
