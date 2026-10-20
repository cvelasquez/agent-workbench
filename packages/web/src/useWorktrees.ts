/**
 * Las ramas aparte del lado de la web (hito 48, §6.38): las filas de "Ramas
 * aparte" en Cambios y los dos diálogos, crear y quitar.
 *
 * Ningún pedido lleva una ruta (§2.4): una rama nueva sale de un proyecto o de
 * una pestaña, y una que ya existe se nombra por el id del registro del
 * servidor. Los errores de un diálogo los muestra ese diálogo, no el aviso de
 * arriba (`isWorktreeDialogRequest`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentId,
  TerminalId,
  WorktreeCreateMode,
  WorktreeInspection,
  WorktreeRemoveOutcome,
  WorktreeRemovePlan,
  WorktreeRow,
  WorktreeSource,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { serverTextMessage } from './i18n/server-text.js';

/** Los pedidos de los diálogos: su error lo explica el diálogo. Como los del panel de memoria. */
const dialogRequests = new Set<string>();

export function isWorktreeDialogRequest(requestId: string | undefined): boolean {
  return requestId !== undefined && dialogRequests.has(requestId);
}

function claim(): string {
  const requestId = crypto.randomUUID();
  dialogRequests.add(requestId);
  return requestId;
}

/** Las filas de "Ramas aparte" de la pestaña que se mira. Se vuelven a pedir con cada estado de git. */
export function useWorktreeRows(
  connection: AgentConnection,
  terminalId: TerminalId | null,
  /** El `updatedAt` del último estado de git: cambia cuando el panel se refresca. */
  gitUpdatedAt: number,
): WorktreeRow[] {
  const [rows, setRows] = useState<WorktreeRow[]>([]);

  useEffect(() => {
    setRows([]);
    if (terminalId === null) return;
    const ask = (): void => {
      connection.send({ type: 'worktree.status', terminalId });
    };
    const offMessage = connection.onMessage((message) => {
      if (message.type === 'worktree.rows' && message.terminalId === terminalId) setRows(message.rows);
      if (message.type === 'worktree.changed') ask();
    });
    const offReopen = connection.onReopen(ask);
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection, terminalId]);

  // Con cada lectura de git del panel: el servidor guarda el resultado unos segundos.
  useEffect(() => {
    if (terminalId !== null && gitUpdatedAt > 0) connection.send({ type: 'worktree.status', terminalId });
  }, [connection, terminalId, gitUpdatedAt]);

  return rows;
}

export type CreateDialogState =
  | { phase: 'loading' }
  | { phase: 'ready'; inspection: WorktreeInspection }
  | { phase: 'creating'; inspection: WorktreeInspection }
  | { phase: 'failed'; inspection: WorktreeInspection | null; message: string };

export type RemoveDialogState =
  | { phase: 'loading' }
  | { phase: 'ready'; plan: WorktreeRemovePlan }
  | { phase: 'removing'; plan: WorktreeRemovePlan }
  | { phase: 'done'; outcome: WorktreeRemoveOutcome }
  | { phase: 'failed'; plan: WorktreeRemovePlan | null; message: string };

export interface CreateDialog {
  source: WorktreeSource;
  /** La carpeta del proyecto, para el lugar y el color de la pestaña en camino. */
  projectCwd: string;
  projectName: string;
  state: CreateDialogState;
}

export interface RemoveDialog {
  worktreeId: string;
  branch: string;
  state: RemoveDialogState;
}

export interface WorktreeCreateChoice {
  branch: string;
  base: string;
  mode: WorktreeCreateMode;
  agent?: AgentId;
  copyNotes: boolean;
}

/** Lo que el workspace hace con una pestaña pedida desde acá: activarla al llegar, y la provisional. */
export type ExpectTab = (requestId: string, pending: { cwd: string; label: string; agent: AgentId | null } | null) => void;

export interface WorktreeDialogs {
  create: CreateDialog | null;
  openCreate: (source: WorktreeSource, projectCwd: string, projectName: string) => void;
  submitCreate: (choice: WorktreeCreateChoice) => void;
  closeCreate: () => void;
  remove: RemoveDialog | null;
  openRemove: (worktreeId: string, branch: string) => void;
  confirmRemove: (discardConflicts: boolean) => void;
  /** Deja en el cuadro del agente de la rama el pedido de pasar las notas que chocaron. */
  askNotes: () => void;
  closeRemove: () => void;
  /** Vuelve a abrir la rama quitada de una sesión de la barra. Su error va al aviso de arriba. */
  reopen: (agent: AgentId, sessionId: string, projectCwd: string, label: string) => void;
}

export function useWorktreeDialogs(
  connection: AgentConnection,
  expectTab: ExpectTab,
  activate: (terminalId: TerminalId) => void,
): WorktreeDialogs {
  const [create, setCreate] = useState<CreateDialog | null>(null);
  const [remove, setRemove] = useState<RemoveDialog | null>(null);
  /** El pedido en curso de cada diálogo: una respuesta de otro pedido no se aplica. */
  const createRequest = useRef<string | null>(null);
  const removeRequest = useRef<string | null>(null);
  const notesRequest = useRef<string | null>(null);

  useEffect(
    () =>
      connection.onMessage((message) => {
        switch (message.type) {
          case 'worktree.inspected':
            if (message.requestId !== createRequest.current) break;
            setCreate((current) => (current === null ? null : { ...current, state: { phase: 'ready', inspection: message.inspection } }));
            break;
          case 'terminal.opened':
            if (message.requestId === createRequest.current) {
              createRequest.current = null;
              setCreate(null);
            }
            break;
          case 'worktree.removePlan':
            if (message.requestId !== removeRequest.current) break;
            setRemove((current) => (current === null ? null : { ...current, state: { phase: 'ready', plan: message.plan } }));
            break;
          case 'worktree.removed':
            if (message.requestId !== removeRequest.current) break;
            removeRequest.current = null;
            setRemove((current) => (current === null ? null : { ...current, state: { phase: 'done', outcome: message.outcome } }));
            break;
          case 'composer.prefill':
            // El pedido de las notas quedó en el cuadro de esa pestaña: se la muestra.
            if (message.reason === 'requested' && notesRequest.current !== null) {
              notesRequest.current = null;
              activate(message.terminalId);
            }
            break;
          case 'error': {
            const text = serverTextMessage(message.text);
            if (message.requestId !== undefined && message.requestId === createRequest.current) {
              createRequest.current = null;
              setCreate((current) => {
                if (current === null) return null;
                const inspection = current.state.phase === 'loading' ? null : current.state.inspection;
                return { ...current, state: { phase: 'failed', inspection, message: text } };
              });
            }
            if (message.requestId !== undefined && message.requestId === removeRequest.current) {
              removeRequest.current = null;
              setRemove((current) => {
                if (current === null) return null;
                const plan = current.state.phase === 'ready' || current.state.phase === 'removing' ? current.state.plan : null;
                return { ...current, state: { phase: 'failed', plan, message: text } };
              });
            }
            // El de las notas va al aviso de arriba: su diálogo ya se cerró.
            if (message.requestId !== undefined && message.requestId === notesRequest.current) notesRequest.current = null;
            break;
          }
          default:
            break;
        }
      }),
    [connection, activate],
  );

  const openCreate = useCallback(
    (source: WorktreeSource, projectCwd: string, projectName: string) => {
      const requestId = claim();
      createRequest.current = requestId;
      setCreate({ source, projectCwd, projectName, state: { phase: 'loading' } });
      connection.send({ type: 'worktree.inspect', requestId, source });
    },
    [connection],
  );

  const submitCreate = useCallback(
    (choice: WorktreeCreateChoice) => {
      if (create === null || (create.state.phase !== 'ready' && create.state.phase !== 'failed')) return;
      const { inspection } = create.state;
      if (inspection === null) return;
      const requestId = claim();
      createRequest.current = requestId;
      setCreate({ ...create, state: { phase: 'creating', inspection } });
      expectTab(requestId, { cwd: create.projectCwd, label: choice.branch, agent: choice.agent ?? null });
      connection.send({
        type: 'worktree.create',
        requestId,
        source: create.source,
        branch: choice.branch,
        base: choice.base,
        mode: choice.mode,
        copyNotes: choice.copyNotes,
        ...(choice.agent !== undefined ? { agent: choice.agent } : {}),
      });
    },
    [connection, create, expectTab],
  );

  const closeCreate = useCallback(() => {
    // Lo que esté en camino sigue: si llega la pestaña, se abre igual.
    if (create?.state.phase !== 'creating') createRequest.current = null;
    setCreate(null);
  }, [create]);

  const planRemove = useCallback(
    (worktreeId: string) => {
      const requestId = claim();
      removeRequest.current = requestId;
      connection.send({ type: 'worktree.planRemove', requestId, worktreeId });
    },
    [connection],
  );

  const openRemove = useCallback(
    (worktreeId: string, branch: string) => {
      setRemove({ worktreeId, branch, state: { phase: 'loading' } });
      planRemove(worktreeId);
    },
    [planRemove],
  );

  const confirmRemove = useCallback(
    (discardConflicts: boolean) => {
      if (remove === null || remove.state.phase !== 'ready') return;
      const requestId = claim();
      removeRequest.current = requestId;
      setRemove({ ...remove, state: { phase: 'removing', plan: remove.state.plan } });
      connection.send({ type: 'worktree.remove', requestId, worktreeId: remove.worktreeId, discardConflicts });
    },
    [connection, remove],
  );

  const askNotes = useCallback(() => {
    if (remove === null) return;
    const requestId = crypto.randomUUID();
    notesRequest.current = requestId;
    // Si la rama no tiene pestaña, el servidor abre una: que pase a ser la activa.
    expectTab(requestId, null);
    connection.send({ type: 'worktree.askNotes', requestId, worktreeId: remove.worktreeId });
    setRemove(null);
  }, [connection, expectTab, remove]);

  const closeRemove = useCallback(() => {
    removeRequest.current = null;
    setRemove(null);
  }, []);

  const reopen = useCallback(
    (agent: AgentId, sessionId: string, projectCwd: string, label: string) => {
      const requestId = crypto.randomUUID();
      expectTab(requestId, { cwd: projectCwd, label, agent });
      connection.send({ type: 'worktree.reopen', requestId, agent, sessionId });
    },
    [connection, expectTab],
  );

  return { create, openCreate, submitCreate, closeCreate, remove, openRemove, confirmRemove, askNotes, closeRemove, reopen };
}
