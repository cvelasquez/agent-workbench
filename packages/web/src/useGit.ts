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
 *
 * Al volver a una pestana se muestra su ultimo estado, marcado como viejo,
 * hasta que llega el de ahora (28-10-2026, §6.2.1): `git-last-state.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_GIT_STATUS,
  type GitDiff,
  type GitStatus,
  type TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { LastStateCache, rememberGitStatus } from './git-last-state.js';

/** De todas las pestanas, y de la pagina entera: sobrevive a cambiar de pestana y a cerrar el panel. */
const lastStatus = new LastStateCache<GitStatus>();

export interface GitView {
  status: GitStatus;
  /** `status` es el guardado de la ultima vez: todavia no llego el de ahora. */
  stale: boolean;
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
  const [stale, setStale] = useState(false);
  const staleRef = useRef(false);
  /*
    El diff que se pidio con el estado guardado. El servidor contesta un diff
    solo con el repo ya leido, y hasta que llega el estado de ahora diria que no
    lo conoce: se pide en cuanto llega, y mientras el panel dice que lo esta
    leyendo.
  */
  const pendingDiffRef = useRef<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  useEffect(() => {
    const markStale = (value: boolean): void => {
      staleRef.current = value;
      setStale(value);
    };

    if (terminalId === null) {
      setStatus(EMPTY_GIT_STATUS);
      markStale(false);
      setDiff(null);
      return;
    }

    // Al cambiar de pestana, nunca el estado del repo anterior: mostrarlo un
    // instante es peor que un panel vacio. Si, el ultimo de esta misma pestana,
    // como viejo (§6.2.1).
    const entered = lastStatus.enter(terminalId, EMPTY_GIT_STATUS);
    setStatus(entered.value);
    markStale(entered.stale);
    pendingDiffRef.current = null;
    setDiff(null);
    setLoadingDiff(false);

    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'git.status': {
          if (message.terminalId !== terminalId) break;
          rememberGitStatus(lastStatus, terminalId, message.status);
          setStatus(message.status);
          markStale(false);
          const pending = pendingDiffRef.current;
          pendingDiffRef.current = null;
          if (pending === null) break;
          if (message.status.state === 'ready') {
            connection.send({ type: 'git.diff', terminalId, path: pending.path, staged: pending.staged });
          } else {
            setLoadingDiff(false);
          }
          break;
        }
        case 'git.diff':
          if (message.terminalId !== terminalId) break;
          setDiff(message.diff);
          setLoadingDiff(false);
          break;
        case 'error':
          // Un diff que falla no puede dejar el panel girando para siempre.
          setLoadingDiff(false);
          pendingDiffRef.current = null;
          // La pestana ya no esta en el servidor (es lo que contesta la
          // suscripcion): lo guardado tampoco sirve, y el panel queda como antes.
          if (message.code === 'unknown-terminal' && staleRef.current) {
            lastStatus.forget(terminalId);
            setStatus(EMPTY_GIT_STATUS);
            markStale(false);
          }
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
      if (staleRef.current) {
        pendingDiffRef.current = { path, staged };
        return;
      }
      connection.send({ type: 'git.diff', terminalId, path, staged });
    },
    [connection, terminalId],
  );

  const closeDiff = useCallback(() => {
    pendingDiffRef.current = null;
    setDiff(null);
    setLoadingDiff(false);
  }, []);

  const refresh = useCallback(() => {
    if (terminalId === null) return;
    connection.send({ type: 'git.refresh', terminalId });
  }, [connection, terminalId]);

  return { status, stale, diff, loadingDiff, openDiff, closeDiff, refresh };
}
