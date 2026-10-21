/**
 * Las ramas aparte del lado de la web (hito 48, §6.38): las filas de "Ramas
 * aparte" en Cambios y los dos diálogos, crear y quitar. Desde el hito 49,
 * `useWorktreeTeam`: "Ver cambios", pedir revisión, integrar y los dos pedidos
 * que quedan en el cuadro del autor (mandarle la revisión, ponerse al día).
 *
 * Ningún pedido lleva una ruta (§2.4): una rama nueva sale de un proyecto o de
 * una pestaña, y una que ya existe se nombra por el id del registro del
 * servidor. Los errores de un diálogo los muestra ese diálogo, no el aviso de
 * arriba (`isWorktreeDialogRequest`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentId,
  GitDiff,
  ServerComposerPrefillMessage,
  TerminalId,
  WorktreeChanges,
  WorktreeCreateMode,
  WorktreeDeleteBranchPlan,
  WorktreeInspection,
  WorktreeIntegrateOutcome,
  WorktreeIntegratePlan,
  WorktreeKeptBranch,
  WorktreeRemoveOutcome,
  WorktreeRemovePlan,
  WorktreeReviewPlan,
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

/**
 * Si un prellenado contesta el pedido en curso: el del hito 49 dice a cuál, y
 * así un pedido que llega al mismo tiempo (la revisión de otra rama) no pasa a
 * la vista su pestaña. Un servidor del 48 no lo dice: el que esté en curso.
 */
function answersRequest(message: Pick<ServerComposerPrefillMessage, 'reason' | 'requestId'>, pending: string | null): boolean {
  return message.reason === 'requested' && pending !== null && (message.requestId === undefined || message.requestId === pending);
}

/**
 * "Ramas aparte" de la pestaña que se mira: las filas, y desde el 20-10-2026 las
 * ramas guardadas (sin carpeta, todavía en el repo).
 */
export interface WorktreeRowsState {
  rows: WorktreeRow[];
  kept: WorktreeKeptBranch[];
}

const NO_ROWS: WorktreeRowsState = { rows: [], kept: [] };

/** Las filas de "Ramas aparte" de la pestaña que se mira. Se vuelven a pedir con cada estado de git. */
export function useWorktreeRows(
  connection: AgentConnection,
  terminalId: TerminalId | null,
  /** El `updatedAt` del último estado de git: cambia cuando el panel se refresca. */
  gitUpdatedAt: number,
): WorktreeRowsState {
  const [rows, setRows] = useState<WorktreeRowsState>(NO_ROWS);

  useEffect(() => {
    setRows(NO_ROWS);
    if (terminalId === null) return;
    const ask = (): void => {
      connection.send({ type: 'worktree.status', terminalId });
    };
    const offMessage = connection.onMessage((message) => {
      // Un servidor anterior no manda las guardadas: ninguna.
      if (message.type === 'worktree.rows' && message.terminalId === terminalId) setRows({ rows: message.rows, kept: message.kept ?? [] });
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

export type DeleteBranchDialogState =
  | { phase: 'loading' }
  | { phase: 'ready'; plan: WorktreeDeleteBranchPlan }
  | { phase: 'deleting'; plan: WorktreeDeleteBranchPlan }
  | { phase: 'done' }
  | { phase: 'failed'; plan: WorktreeDeleteBranchPlan | null; message: string };

/** "Borrar la rama" de una rama guardada (20-10-2026). */
export interface DeleteBranchDialog {
  worktreeId: string;
  branch: string;
  state: DeleteBranchDialogState;
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
  deleteBranch: DeleteBranchDialog | null;
  openDeleteBranch: (worktreeId: string, branch: string) => void;
  confirmDeleteBranch: () => void;
  closeDeleteBranch: () => void;
}

export function useWorktreeDialogs(
  connection: AgentConnection,
  expectTab: ExpectTab,
  activate: (terminalId: TerminalId) => void,
): WorktreeDialogs {
  const [create, setCreate] = useState<CreateDialog | null>(null);
  const [remove, setRemove] = useState<RemoveDialog | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<DeleteBranchDialog | null>(null);
  /** El pedido en curso de cada diálogo: una respuesta de otro pedido no se aplica. */
  const createRequest = useRef<string | null>(null);
  const removeRequest = useRef<string | null>(null);
  const notesRequest = useRef<string | null>(null);
  const deleteBranchRequest = useRef<string | null>(null);

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
          case 'worktree.deleteBranchPlan':
            if (message.requestId !== deleteBranchRequest.current) break;
            setDeleteBranch((current) => (current === null ? null : { ...current, state: { phase: 'ready', plan: message.plan } }));
            break;
          case 'worktree.branchDeleted':
            if (message.requestId !== deleteBranchRequest.current) break;
            deleteBranchRequest.current = null;
            setDeleteBranch((current) => (current === null ? null : { ...current, state: { phase: 'done' } }));
            break;
          case 'composer.prefill':
            // El pedido de las notas quedó en el cuadro de esa pestaña: se la muestra.
            if (answersRequest(message, notesRequest.current)) {
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
            if (message.requestId !== undefined && message.requestId === deleteBranchRequest.current) {
              deleteBranchRequest.current = null;
              setDeleteBranch((current) => {
                if (current === null) return null;
                const plan = current.state.phase === 'ready' || current.state.phase === 'deleting' ? current.state.plan : null;
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

  const openDeleteBranch = useCallback(
    (worktreeId: string, branch: string) => {
      const requestId = claim();
      deleteBranchRequest.current = requestId;
      setDeleteBranch({ worktreeId, branch, state: { phase: 'loading' } });
      connection.send({ type: 'worktree.planDeleteBranch', requestId, worktreeId });
    },
    [connection],
  );

  const confirmDeleteBranch = useCallback(() => {
    if (deleteBranch === null || deleteBranch.state.phase !== 'ready' || deleteBranch.state.plan.blocker !== null) return;
    const requestId = claim();
    deleteBranchRequest.current = requestId;
    setDeleteBranch({ ...deleteBranch, state: { phase: 'deleting', plan: deleteBranch.state.plan } });
    connection.send({ type: 'worktree.deleteBranch', requestId, worktreeId: deleteBranch.worktreeId });
  }, [connection, deleteBranch]);

  const closeDeleteBranch = useCallback(() => {
    deleteBranchRequest.current = null;
    setDeleteBranch(null);
  }, []);

  return {
    create,
    openCreate,
    submitCreate,
    closeCreate,
    remove,
    openRemove,
    confirmRemove,
    askNotes,
    closeRemove,
    reopen,
    deleteBranch,
    openDeleteBranch,
    confirmDeleteBranch,
    closeDeleteBranch,
  };
}

// ---------------------------------------------------------------------------
// Hito 49: ver cambios, revisar, ponerse al dia e integrar
// ---------------------------------------------------------------------------

/** "Ver cambios" de una rama: lo que trae, y el diff de un archivo cuando se abre uno. */
export interface ChangesView {
  worktreeId: string;
  branch: string;
  state: { phase: 'loading' } | { phase: 'ready'; changes: WorktreeChanges } | { phase: 'failed'; message: string };
  /** El archivo abierto, o null: la lista. */
  diff: { path: string; diff: GitDiff | null; message: string | null } | null;
}

export type ReviewDialogState =
  | { phase: 'loading' }
  | { phase: 'ready'; plan: WorktreeReviewPlan }
  | { phase: 'requesting'; plan: WorktreeReviewPlan }
  | { phase: 'failed'; plan: WorktreeReviewPlan | null; message: string };

export interface ReviewDialog {
  worktreeId: string;
  branch: string;
  /** La carpeta del proyecto, para el lugar y el color de la pestana en camino. */
  projectCwd: string;
  state: ReviewDialogState;
}

export type IntegrateDialogState =
  | { phase: 'loading' }
  | { phase: 'ready'; plan: WorktreeIntegratePlan }
  | { phase: 'integrating'; plan: WorktreeIntegratePlan }
  | { phase: 'done'; plan: WorktreeIntegratePlan; outcome: WorktreeIntegrateOutcome }
  | { phase: 'failed'; plan: WorktreeIntegratePlan | null; message: string };

export interface IntegrateDialog {
  worktreeId: string;
  branch: string;
  state: IntegrateDialogState;
}

export interface WorktreeTeam {
  changes: ChangesView | null;
  openChanges: (worktreeId: string, branch: string) => void;
  openChangeDiff: (path: string) => void;
  closeChangeDiff: () => void;
  closeChanges: () => void;
  review: ReviewDialog | null;
  openReview: (worktreeId: string, branch: string, projectCwd: string) => void;
  submitReview: (agent: AgentId) => void;
  closeReview: () => void;
  integrate: IntegrateDialog | null;
  openIntegrate: (worktreeId: string, branch: string) => void;
  confirmIntegrate: () => void;
  closeIntegrate: () => void;
  /** Deja la respuesta del revisor en el cuadro de la rama. Su error va al aviso de arriba. */
  sendReview: (worktreeId: string) => void;
  /** Deja el pedido de ponerse al dia en el cuadro de la rama. Su error va al aviso de arriba. */
  catchUp: (worktreeId: string) => void;
}

export function useWorktreeTeam(
  connection: AgentConnection,
  expectTab: ExpectTab,
  activate: (terminalId: TerminalId) => void,
): WorktreeTeam {
  const [changes, setChanges] = useState<ChangesView | null>(null);
  const [review, setReview] = useState<ReviewDialog | null>(null);
  const [integrate, setIntegrate] = useState<IntegrateDialog | null>(null);
  const changesRequest = useRef<string | null>(null);
  const diffRequest = useRef<string | null>(null);
  const reviewRequest = useRef<string | null>(null);
  const integrateRequest = useRef<string | null>(null);
  /** El pedido para el autor en curso: cuando su texto llega a un cuadro, esa pestana pasa a la vista. */
  const authorRequest = useRef<string | null>(null);

  useEffect(
    () =>
      connection.onMessage((message) => {
        switch (message.type) {
          case 'worktree.branchChanges':
            if (message.requestId !== changesRequest.current) break;
            changesRequest.current = null;
            setChanges((current) => (current === null ? null : { ...current, state: { phase: 'ready', changes: message.changes } }));
            break;
          case 'worktree.branchDiff':
            if (message.requestId !== diffRequest.current) break;
            diffRequest.current = null;
            setChanges((current) =>
              current === null || current.diff === null ? current : { ...current, diff: { ...current.diff, diff: message.diff } },
            );
            break;
          case 'worktree.reviewPlan':
            if (message.requestId !== reviewRequest.current) break;
            reviewRequest.current = null;
            setReview((current) => (current === null ? null : { ...current, state: { phase: 'ready', plan: message.plan } }));
            break;
          case 'terminal.opened':
            // La pestana del revisor llego: el dialogo ya cumplio.
            if (message.requestId !== undefined && message.requestId === reviewRequest.current) {
              reviewRequest.current = null;
              setReview(null);
            }
            break;
          case 'worktree.integratePlan':
            if (message.requestId !== integrateRequest.current) break;
            integrateRequest.current = null;
            setIntegrate((current) => (current === null ? null : { ...current, state: { phase: 'ready', plan: message.plan } }));
            break;
          case 'worktree.integrated':
            if (message.requestId !== integrateRequest.current) break;
            integrateRequest.current = null;
            setIntegrate((current) => {
              if (current === null) return null;
              const plan = current.state.phase === 'integrating' ? current.state.plan : null;
              return plan === null ? current : { ...current, state: { phase: 'done', plan, outcome: message.outcome } };
            });
            break;
          case 'composer.prefill':
            // El pedido para el autor quedo en el cuadro de esa pestana: se la muestra.
            if (answersRequest(message, authorRequest.current)) {
              authorRequest.current = null;
              activate(message.terminalId);
            }
            break;
          case 'error': {
            const { requestId } = message;
            if (requestId === undefined) break;
            const text = serverTextMessage(message.text);
            if (requestId === changesRequest.current) {
              changesRequest.current = null;
              setChanges((current) => (current === null ? null : { ...current, state: { phase: 'failed', message: text } }));
            }
            if (requestId === diffRequest.current) {
              diffRequest.current = null;
              setChanges((current) =>
                current === null || current.diff === null ? current : { ...current, diff: { ...current.diff, message: text } },
              );
            }
            if (requestId === reviewRequest.current) {
              reviewRequest.current = null;
              setReview((current) => {
                if (current === null) return null;
                const plan = current.state.phase === 'loading' || current.state.phase === 'failed' ? null : current.state.plan;
                return { ...current, state: { phase: 'failed', plan, message: text } };
              });
            }
            if (requestId === integrateRequest.current) {
              integrateRequest.current = null;
              setIntegrate((current) => {
                if (current === null) return null;
                const plan = current.state.phase === 'ready' || current.state.phase === 'integrating' ? current.state.plan : null;
                return { ...current, state: { phase: 'failed', plan, message: text } };
              });
            }
            // El de un pedido para el autor va al aviso de arriba: no tiene dialogo.
            if (requestId === authorRequest.current) authorRequest.current = null;
            break;
          }
          default:
            break;
        }
      }),
    [connection, activate],
  );

  const openChanges = useCallback(
    (worktreeId: string, branch: string) => {
      const requestId = claim();
      changesRequest.current = requestId;
      diffRequest.current = null;
      setChanges({ worktreeId, branch, state: { phase: 'loading' }, diff: null });
      connection.send({ type: 'worktree.changes', requestId, worktreeId });
    },
    [connection],
  );

  const openChangeDiff = useCallback(
    (path: string) => {
      if (changes === null) return;
      const requestId = claim();
      diffRequest.current = requestId;
      setChanges({ ...changes, diff: { path, diff: null, message: null } });
      connection.send({ type: 'worktree.changesDiff', requestId, worktreeId: changes.worktreeId, path });
    },
    [connection, changes],
  );

  const closeChangeDiff = useCallback(() => {
    diffRequest.current = null;
    setChanges((current) => (current === null ? null : { ...current, diff: null }));
  }, []);

  const closeChanges = useCallback(() => {
    changesRequest.current = null;
    diffRequest.current = null;
    setChanges(null);
  }, []);

  const openReview = useCallback(
    (worktreeId: string, branch: string, projectCwd: string) => {
      const requestId = claim();
      reviewRequest.current = requestId;
      setReview({ worktreeId, branch, projectCwd, state: { phase: 'loading' } });
      connection.send({ type: 'worktree.planReview', requestId, worktreeId });
    },
    [connection],
  );

  const submitReview = useCallback(
    (agent: AgentId) => {
      if (review === null || (review.state.phase !== 'ready' && review.state.phase !== 'failed')) return;
      const { plan } = review.state;
      if (plan === null) return;
      const requestId = claim();
      reviewRequest.current = requestId;
      setReview({ ...review, state: { phase: 'requesting', plan } });
      // La provisional se llama como se va a llamar la de verdad: como su proyecto.
      const label = review.projectCwd.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? review.projectCwd;
      expectTab(requestId, { cwd: review.projectCwd, label, agent });
      connection.send({ type: 'worktree.requestReview', requestId, worktreeId: review.worktreeId, agent });
    },
    [connection, expectTab, review],
  );

  const closeReview = useCallback(() => {
    // Lo que esta en camino sigue: si llega la pestana, se abre igual.
    if (review?.state.phase !== 'requesting') reviewRequest.current = null;
    setReview(null);
  }, [review]);

  const openIntegrate = useCallback(
    (worktreeId: string, branch: string) => {
      const requestId = claim();
      integrateRequest.current = requestId;
      setIntegrate({ worktreeId, branch, state: { phase: 'loading' } });
      connection.send({ type: 'worktree.planIntegrate', requestId, worktreeId });
    },
    [connection],
  );

  const confirmIntegrate = useCallback(() => {
    if (integrate === null || integrate.state.phase !== 'ready') return;
    const requestId = claim();
    integrateRequest.current = requestId;
    const { plan } = integrate.state;
    setIntegrate({ ...integrate, state: { phase: 'integrating', plan } });
    // La punta que mostró el plan: si la rama avanzó desde entonces, el servidor no integra nada.
    connection.send({
      type: 'worktree.integrate',
      requestId,
      worktreeId: integrate.worktreeId,
      ...(plan.branchCommit !== null ? { branchCommit: plan.branchCommit } : {}),
    });
  }, [connection, integrate]);

  const closeIntegrate = useCallback(() => {
    integrateRequest.current = null;
    setIntegrate(null);
  }, []);

  const askAuthor = useCallback(
    (type: 'worktree.sendReview' | 'worktree.catchUp', worktreeId: string) => {
      // Sin reclamar: su error va al aviso de arriba. Si la rama no tiene pestana, la que se abre pasa a la vista.
      const requestId = crypto.randomUUID();
      authorRequest.current = requestId;
      expectTab(requestId, null);
      connection.send({ type, requestId, worktreeId });
    },
    [connection, expectTab],
  );

  const sendReview = useCallback((worktreeId: string) => askAuthor('worktree.sendReview', worktreeId), [askAuthor]);
  const catchUp = useCallback((worktreeId: string) => askAuthor('worktree.catchUp', worktreeId), [askAuthor]);

  return {
    changes,
    openChanges,
    openChangeDiff,
    closeChangeDiff,
    closeChanges,
    review,
    openReview,
    submitReview,
    closeReview,
    integrate,
    openIntegrate,
    confirmIntegrate,
    closeIntegrate,
    sendReview,
    catchUp,
  };
}
