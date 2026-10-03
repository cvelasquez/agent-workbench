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
 *
 * Desde el Hito 40 el contenido de los abiertos es de `useDocuments` (§6.31):
 * aca queda la lista.
 */

import { useEffect, useState } from 'react';
import type { SessionPlan, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export interface PlansView {
  plans: SessionPlan[];
}

export function usePlans(connection: AgentConnection, terminalId: TerminalId | null): PlansView {
  const [plans, setPlans] = useState<SessionPlan[]>([]);

  useEffect(() => {
    setPlans([]);
    if (terminalId === null) return;

    return connection.onMessage((message) => {
      switch (message.type) {
        case 'conversation.plans':
          if (message.terminalId !== terminalId) break;
          setPlans(message.plans);
          break;
        default:
          break;
      }
    });
  }, [connection, terminalId]);

  return { plans };
}
