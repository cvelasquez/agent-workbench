/**
 * Lo que Ajustes lee y cambia del servidor (Hito 41, §6.32): con que consola
 * abre una nueva, y que CLIs no se usan.
 *
 * Como el acceso remoto: el estado es uno solo y lo manda el servidor —al
 * conectar y en cada cambio (`settings.status`)—. Un servidor anterior no lo
 * manda, y Ajustes muestra solo lo que es de la ventana.
 *
 * Un cambio que el servidor no acepto —una consola que ya no esta, un disco que
 * no deja escribir— llega como `settings-failed` y queda en `problem`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AgentId, AppSettingsStatus, ConsoleShellId, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { serverTextMessage } from './i18n/server-text.js';

export interface AppSettingsApi {
  /** null hasta el primer `settings.status`: un servidor anterior al Hito 41. */
  status: AppSettingsStatus | null;
  problem: string | null;
  setConsoleShell: (shell: ConsoleShellId) => void;
  setDisabledAgents: (agents: AgentId[]) => void;
  dismissProblem: () => void;
}

export function useAppSettings(connection: AgentConnection): AppSettingsApi {
  const [status, setStatus] = useState<AppSettingsStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(
    () =>
      connection.onMessage((message: ServerMessage) => {
        switch (message.type) {
          case 'settings.status':
            setStatus(message.settings);
            setProblem(null);
            break;
          case 'error':
            if (message.code !== 'settings-failed') break;
            setProblem(serverTextMessage(message.text));
            if (message.detail !== undefined) console.error('[servidor]', message.detail);
            break;
          default:
            break;
        }
      }),
    [connection],
  );

  const setConsoleShell = useCallback(
    (shell: ConsoleShellId) => connection.send({ type: 'settings.update', consoleShell: shell }),
    [connection],
  );
  const setDisabledAgents = useCallback(
    (agents: AgentId[]) => connection.send({ type: 'settings.update', disabledAgents: agents }),
    [connection],
  );
  const dismissProblem = useCallback(() => setProblem(null), []);

  return { status, problem, setConsoleShell, setDisabledAgents, dismissProblem };
}
