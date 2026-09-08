/**
 * Estado de git de la pestana que se esta mirando.
 *
 * Se suscribe a una sola pestana, la visible, y solo mientras el panel de
 * cambios esta abierto. Es la misma regla que la conversacion y por el mismo
 * motivo: cada suscripcion mantiene un watcher y un `git status` periodico del
 * lado del servidor, y no tiene sentido pagarlos por paneles que nadie mira.
 *
 * La suscripcion se rehace al reconectar: el servidor solo mantiene el
 * seguimiento mientras haya alguien enganchado, asi que tras un `F5` hay que
 * volver a pedirlo o el panel se queda congelado.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  EMPTY_GIT_STATUS,
  type GitDiff,
  type GitStatus,
  type TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export interface GitView {
  status: GitStatus;
  /** Diff abierto, o null si se esta viendo la lista. */
  diff: GitDiff | null;
  loadingDiff: boolean;
  openDiff: (path: string, staged: boolean) => void;
  closeDiff: () => void;
  refresh: () => void;
}

export function useGit(
  connection: AgentConnection,
  terminalId: TerminalId | null,
): GitView {
  const [status, setStatus] = useState<GitStatus>(EMPTY_GIT_STATUS);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    if (terminalId === null) {
      setStatus(EMPTY_GIT_STATUS);
      setDiff(null);
      return;
    }

    // Estado limpio al cambiar de pestana: mostrar los cambios del repo
    // anterior un instante es peor que mostrar un panel vacio.
    setStatus(EMPTY_GIT_STATUS);
    setDiff(null);
    setLoadingDiff(false);

    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'git.status':
          if (message.terminalId === terminalId) setStatus(message.status);
          break;
        case 'git.diff':
          if (message.terminalId !== terminalId) break;
          setDiff(message.diff);
          setLoadingDiff(false);
          break;
        case 'error':
          // Un diff que falla no puede dejar el panel girando para siempre.
          setLoadingDiff(false);
          break;
        default:
          break;
      }
    });

    connection.send({ type: 'git.subscribe', terminalId });
    const offReopen = connection.onReopen(() => {
      connection.send({ type: 'git.subscribe', terminalId });
    });

    return () => {
      offMessage();
      offReopen();
      connection.send({ type: 'git.unsubscribe', terminalId });
    };
  }, [connection, terminalId]);

  const openDiff = useCallback(
    (path: string, staged: boolean) => {
      if (terminalId === null) return;
      setLoadingDiff(true);
      setDiff(null);
      connection.send({ type: 'git.diff', terminalId, path, staged });
    },
    [connection, terminalId],
  );

  const closeDiff = useCallback(() => {
    setDiff(null);
    setLoadingDiff(false);
  }, []);

  const refresh = useCallback(() => {
    if (terminalId === null) return;
    connection.send({ type: 'git.refresh', terminalId });
  }, [connection, terminalId]);

  return { status, diff, loadingDiff, openDiff, closeDiff, refresh };
}
