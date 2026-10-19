/**
 * Los limites del plan de cada CLI (hito 47, §6.37), tal como los manda el
 * servidor: al conectar, si sabe algo, y a todas las ventanas en cada cambio
 * (`plan.limits`). Un servidor anterior no los manda, y la lista queda vacia.
 *
 * Una reconexion no los borra: el servidor vuelve a mandar lo que sabe, y entre
 * tanto lo ultimo visto sigue valiendo (las ventanas vencidas las descarta el
 * medidor por la hora).
 */

import { useEffect, useState } from 'react';
import type { PlanLimits, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export function usePlanLimits(connection: AgentConnection): readonly PlanLimits[] {
  const [limits, setLimits] = useState<readonly PlanLimits[]>([]);

  useEffect(
    () =>
      connection.onMessage((message: ServerMessage) => {
        if (message.type === 'plan.limits') setLimits(message.limits);
      }),
    [connection],
  );

  return limits;
}
