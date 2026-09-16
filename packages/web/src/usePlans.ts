/**
 * Los documentos que escribio la conversacion de la pestana visible.
 *
 * No pide nada al suscribirse: la lista llega sola con la conversacion
 * (`conversation.plans`), porque quien sabe que documentos tiene una sesion es
 * el mismo que lee su JSONL. Lo unico que se pide es el **contenido**, y solo
 * cuando alguien abre uno — son diez o quince KB de markdown cada uno y no hay
 * razon para traerlos todos por si acaso.
 *
 * Lo que viaja es la **ref opaca** que mando el servidor, nunca una ruta: la
 * raiz la pone el, comprueba que el documento sea de esta conversacion y la
 * resuelve con el guardia de rutas antes de abrirlo (hito 31).
 */

import { useCallback, useEffect, useState } from 'react';
import type { PlanContent, SessionPlan, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export interface PlansView {
  plans: SessionPlan[];
  /** El plan abierto, o null si se esta viendo la lista. */
  open: PlanContent | null;
  /** Titulo del que se pidio y todavia no llego. La ref no se muestra nunca. */
  loading: string | null;
  openPlan: (plan: SessionPlan) => void;
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
    (plan: SessionPlan) => {
      if (terminalId === null) return;
      // El titulo, no la ref: `proj:plans/x.md` no es un encabezado.
      setLoading(plan.title);
      setOpen(null);
      connection.send({ type: 'plans.read', terminalId, fileName: plan.fileName });
    },
    [connection, terminalId],
  );

  const closePlan = useCallback(() => {
    setOpen(null);
    setLoading(null);
  }, []);

  return { plans, open, loading, openPlan, closePlan };
}
