/**
 * La copia propia (hito 28), del lado del navegador.
 *
 * El estado es uno solo y lo manda el servidor: al conectar y a todos en cada
 * cambio (`vault.status`). Aca no se adivina nada —ni que "Activar" funciono,
 * ni que la mudanza termino—: se dibuja el ultimo estado que llego. Lo unico
 * propio de esta ventana es lo que el servidor contesta solo a quien pidio:
 * un fallo (`vault-failed`) y el acuse de una exportacion (`vault.exported`).
 *
 * **Ningun pedido nombra una ruta** (CLAUDE.md 2.4). Mudar la carpeta manda el
 * `pickerId` de un selector abierto: la carpeta es donde esta parado ese
 * selector del servidor. Una sesion va por `(agent, sessionId)` y un proyecto
 * por su `key`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ServerMessage, SessionAgentId, VaultStatus } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { serverTextMessage } from './i18n/server-text.js';

export interface VaultExported {
  projectKey: string;
  sessions: number;
  /** Cuando llego: dos exportaciones seguidas del mismo proyecto son dos acuses. */
  at: number;
}

export interface VaultApi {
  /** null hasta el primer `vault.status` (o con un servidor anterior al hito 28). */
  status: VaultStatus | null;
  /** El ultimo pedido que fallo, con el texto del servidor. */
  problem: string | null;
  /** Proyectos exportandose: el pedido salio y la respuesta no llego. */
  exporting: ReadonlySet<string>;
  lastExported: VaultExported | null;
  measure: () => void;
  setEnabled: (enabled: boolean) => void;
  /**
   * Muda la copia a donde esta parado ese selector. Se llama **antes** de
   * cerrarlo: el servidor lee la carpeta del selector abierto.
   */
  chooseDir: (pickerId: string) => void;
  exportProject: (projectKey: string) => void;
  openSession: (agent: SessionAgentId, sessionId: string) => void;
  reveal: () => void;
  dismissProblem: () => void;
}

const NONE: ReadonlySet<string> = new Set();

export function useVault(connection: AgentConnection): VaultApi {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ReadonlySet<string>>(NONE);
  const [lastExported, setLastExported] = useState<VaultExported | null>(null);

  useEffect(() => {
    const offMessage = connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'vault.status':
          setStatus(message.status);
          break;

        case 'vault.exported':
          setExporting((current) => {
            if (!current.has(message.projectKey)) return current;
            const next = new Set(current);
            next.delete(message.projectKey);
            return next;
          });
          setLastExported({ projectKey: message.projectKey, sessions: message.sessions, at: Date.now() });
          break;

        case 'error':
          if (message.code !== 'vault-failed') break;
          setProblem(serverTextMessage(message.text));
          if (message.detail !== undefined) console.error('[servidor]', message.detail);
          // El error no dice de que pedido es: una exportacion pendiente no
          // puede quedarse diciendo "Exportando…" para siempre.
          setExporting(NONE);
          break;

        default:
          break;
      }
    });
    // Lo que estaba en viaje se perdio con el socket; el estado vuelve solo al conectar.
    const offReopen = connection.onReopen(() => setExporting(NONE));
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  const measure = useCallback(() => {
    setProblem(null);
    connection.send({ type: 'vault.measure' });
  }, [connection]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setProblem(null);
      connection.send({ type: 'vault.enable', enabled });
    },
    [connection],
  );

  const chooseDir = useCallback(
    (pickerId: string) => {
      setProblem(null);
      connection.send({ type: 'vault.setDir', pickerId });
    },
    [connection],
  );

  const exportProject = useCallback(
    (projectKey: string) => {
      setProblem(null);
      setExporting((current) => new Set(current).add(projectKey));
      connection.send({ type: 'vault.exportProject', projectKey });
    },
    [connection],
  );

  const openSession = useCallback(
    (agent: SessionAgentId, sessionId: string) => {
      setProblem(null);
      connection.send({ type: 'vault.openSession', agent, sessionId });
    },
    [connection],
  );

  const reveal = useCallback(() => {
    setProblem(null);
    connection.send({ type: 'vault.reveal' });
  }, [connection]);

  const dismissProblem = useCallback(() => setProblem(null), []);

  return {
    status,
    problem,
    exporting,
    lastExported,
    measure,
    setEnabled,
    chooseDir,
    exportProject,
    openSession,
    reveal,
    dismissProblem,
  };
}
