/**
 * El envio de un mensaje a la pty de una pestana, con las guardas que no dejan
 * escribir sobre un menu (hito 52, §6.39).
 *
 * Es lo que hacia `agent.submit` adentro del socket, sacado con sus
 * dependencias inyectadas para que lo use tambien el reloj de los mensajes
 * programados, como se hizo con "Mandar una nota" en el hito 29 (§6.6.1).
 * **Nada del camino del cuadro cambia**: las mismas comprobaciones, en el mismo
 * orden, la misma fila y las mismas piezas; los textos de error y los acuses
 * siguen en el socket, que recibe un resultado y decide que decir.
 *
 * Dos pasos, como antes: `prepareSubmit` decide en el acto si se puede
 * escribir (un rechazo no espera su turno en la fila), y `runSubmit` hace el
 * trabajo dentro del turno de la pestana en la fila de escritura. Las guardas:
 *
 *  - **Una pestana que no deja ver su estado** (Codex, o Antigravity sin status
 *    line) y tiene una llamada a herramienta sin resultado de este proceso:
 *    puede ser un menu de aprobacion (§10.8). Antes de encolar y antes de cada
 *    pieza.
 *  - **Una CLI cuya confirmacion abierta aprueba lo que llegue** (R27-2) o que
 *    declara que su espera bloquea el cuadro (D12): con el menu abierto, el
 *    Enter caeria sobre la opcion resaltada.
 *  - **El dialogo del arranque** (§12.14): antes de la primera pieza de una
 *    pestana sin conversacion se mira la pantalla.
 *
 * Y, dentro del turno y antes de pegar, **lo escrito en la caja de la CLI** se
 * aparta con su tecla, si la tiene (§5.3.1, `cli-draft.ts`).
 */

import type { AgentAdapter, AgentInput } from './agents/adapter.js';
import type { ServerText, TerminalActivity, TerminalId } from '@agent-workbench/shared';
import { setCliDraftAside, type DraftAside } from './cli-draft.js';
import { buildSubmissionWrites, screenShowsDialog, submissionPayload, submitRefusal, submitStartDelayMs } from './pty-input.js';
import type { EnqueueOptions, PieceGuard, PieceWriter, WriteLane, WriteOutcome } from './terminal-write-queue.js';

/** Lo justo de la pantalla emulada de una pestana (`TerminalRegistry.watchScreen`). */
export interface SubmitScreen {
  lines(): readonly string[] | Promise<readonly string[]>;
  /** Sin el texto atenuado, para leer la caja de la CLI (§5.3.1). */
  linesWithoutFaint?(): Promise<readonly string[]>;
  dispose(): void;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SubmitMessageDeps {
  adapterOf(terminalId: TerminalId): AgentAdapter | null;
  inputOf(terminalId: TerminalId): AgentInput;
  launchedAtOf(terminalId: TerminalId): number | null;
  activityOf(terminalId: TerminalId): TerminalActivity | null;
  /** El id de sesion de la pestana ahora, o null si ya no esta. */
  sessionIdOf(terminalId: TerminalId): string | null;
  watchScreen(terminalId: TerminalId): SubmitScreen | null;
  noteSubmitted(terminalId: TerminalId, text: string): void;
  conversations: {
    isBlindToApprovals(terminalId: TerminalId, adapter: AgentAdapter): boolean;
    getWaitingFor(terminalId: TerminalId): string | null;
    hasOpenToolCall(terminalId: TerminalId, launchedAt: number): boolean;
    checkOpenToolCall(terminalId: TerminalId, launchedAt: number): Promise<boolean>;
    checkWaitingFor(terminalId: TerminalId): Promise<string | null>;
    noteQueued(terminalId: TerminalId, input: { text: string; images: number; at: number }): void;
    noteSent(terminalId: TerminalId, input: { text: string; images: number; at: number }): void;
  };
  queuedSubmits: { note(terminalId: TerminalId, text: string, at: number, original?: string): void };
  enqueue(terminalId: TerminalId, job: (lane: WriteLane) => Promise<void>, options?: EnqueueOptions): Promise<void>;
  now(): number;
  /** La espera entre lecturas de la pantalla al apartar lo escrito. Por omision, un temporizador. */
  wait?(ms: number): Promise<void>;
}

/** Lo que `prepareSubmit` deja decidido para `runSubmit`. */
export interface SubmitPlan {
  terminalId: TerminalId;
  input: AgentInput;
  label: string | null;
  blocksWhileWaiting: boolean;
  pieceGuard: PieceGuard | undefined;
  /** Si una pieza se freno por el dialogo del arranque (lo pone la guarda). */
  stoppedByDialog(): boolean;
  promptQueueSource: 'session' | 'app' | null;
  hasQueuedSubmits: boolean;
}

/** Que se escribe: lo arma quien llama dentro del turno de la fila. */
export interface SubmitContent {
  /** El texto entero, con las lineas de los adjuntos. */
  fullText: string;
  imagePaths: string[];
}

export interface SubmitRequest {
  /** Lo que se escribio, sin los adjuntos: la cola de la app y lo que vuelve al cuadro. */
  text: string;
  imageCount: number;
  /** false: se escribe sin el Enter (`send` del cuadro). */
  send: boolean;
  /**
   * Adentro del turno de la fila, antes de las piezas: guarda las imagenes y los
   * adjuntos. null si fallo; quien llama ya aviso por que.
   */
  prepare(input: AgentInput): Promise<SubmitContent | null>;
  write: PieceWriter;
  /** Apenas termina de escribir, antes de lo que sigue: el acuse del cuadro sale aca. */
  onWritten?(outcome: WriteOutcome): void;
}

/**
 * Como termino. `blocked` dice por que se freno a mitad: el dialogo del
 * arranque, la CLI esperando (`waitingNow`) o una herramienta abierta.
 */
export type SubmitResult =
  | { kind: 'prepare-failed' }
  | { kind: 'nothing' }
  | { kind: 'written' }
  | { kind: 'refused' }
  | { kind: 'interrupted' }
  | { kind: 'blocked'; byDialog: boolean; waitingNow: boolean }
  | { kind: 'dropped' }
  /**
   * La caja de la CLI tenia algo escrito que no se pudo apartar (§5.3.1): ya
   * habia otra cosa apartada, o la tecla no la vacio. No se pego nada.
   */
  | { kind: 'cli-draft' }
  /** El trabajo lanzo despues de empezar: no se sabe cuanto se escribio. */
  | { kind: 'failed' };

/**
 * Decide en el acto, antes de encolar: un rechazo (con su texto) o el plan con
 * sus guardas. La CLI desconocida (pestana sin adaptador) se escribe sin
 * guardas, como siempre.
 */
export function prepareSubmit(deps: SubmitMessageDeps, terminalId: TerminalId): { refusal: ServerText } | SubmitPlan {
  const submitting = deps.adapterOf(terminalId);
  const isBlind = (): boolean =>
    submitting !== null && deps.conversations.isBlindToApprovals(terminalId, submitting);
  const guardsPending = submitting?.capabilities.permissionCycle?.approvesPendingOnCycle === true;
  const blocksWhileWaiting = submitting?.capabilities.waitingBlocksSubmit === true;
  if (submitting !== null) {
    const launchedAt = deps.launchedAtOf(terminalId);
    const blind = isBlind();
    const refusal = submitRefusal({
      label: submitting.label,
      approvesPendingOnCycle: guardsPending,
      waitingFor: deps.conversations.getWaitingFor(terminalId),
      waitingBlocksSubmit: blocksWhileWaiting,
      activity: deps.activityOf(terminalId),
      blind,
      openToolCall: blind && launchedAt !== null && deps.conversations.hasOpenToolCall(terminalId, launchedAt),
    });
    if (refusal !== null) return { refusal };
  }

  // Otra vez antes de cada pieza, leyendo el archivo en el momento (§10.8).
  const approvalGuard =
    submitting !== null && (guardsPending || blocksWhileWaiting || isBlind())
      ? async (): Promise<boolean> => {
          const current = deps.launchedAtOf(terminalId);
          // Sin proceso no hay menu: la escritura la rechaza la terminal.
          if (current === null) return true;
          if (blocksWhileWaiting && deps.activityOf(terminalId) === 'waiting') return false;
          if (isBlind() && (await deps.conversations.checkOpenToolCall(terminalId, current))) return false;
          return !guardsPending || (await deps.conversations.checkWaitingFor(terminalId)) === null;
        }
      : undefined;

  const input = deps.inputOf(terminalId);
  // El dialogo del arranque (§12.14), antes de la primera pieza de una pestana sin conversacion.
  const startupDialog = input.startupDialog;
  const firstMessage = startupDialog !== undefined && (deps.sessionIdOf(terminalId) ?? '') === '';
  let startupChecked = false;
  let stoppedByDialog = false;
  const pieceGuard =
    firstMessage || approvalGuard !== undefined
      ? async (): Promise<boolean> => {
          if (firstMessage && startupDialog !== undefined && !startupChecked) {
            startupChecked = true;
            const screen = deps.watchScreen(terminalId);
            if (screen !== null) {
              try {
                stoppedByDialog = screenShowsDialog(await screen.lines(), startupDialog);
              } finally {
                screen.dispose();
              }
              if (stoppedByDialog) return false;
            }
          }
          return approvalGuard === undefined ? true : approvalGuard();
        }
      : undefined;

  return {
    terminalId,
    input,
    label: submitting?.label ?? null,
    blocksWhileWaiting,
    pieceGuard,
    stoppedByDialog: () => stoppedByDialog,
    promptQueueSource: submitting?.promptQueue?.source ?? null,
    hasQueuedSubmits: submitting?.queuedSubmits !== undefined,
  };
}

/** Hace el envio en el turno de la pestana en la fila de escritura. */
export async function runSubmit(deps: SubmitMessageDeps, plan: SubmitPlan, request: SubmitRequest): Promise<SubmitResult> {
  const { terminalId, input } = plan;
  let result: SubmitResult = { kind: 'dropped' };
  await deps.enqueue(
    terminalId,
    async (lane) => {
      // Desde aca ya no es `dropped`: si algo lanza, queda `failed`.
      result = { kind: 'failed' };
      const content = await request.prepare(input);
      if (content === null) {
        result = { kind: 'prepare-failed' };
        return;
      }
      const { fullText, imagePaths } = content;
      const pieces = buildSubmissionWrites(fullText, imagePaths, input, { send: request.send });
      // Un cuadro vacio no le manda un Enter a la CLI.
      if (pieces === null) {
        result = { kind: 'nothing' };
        return;
      }
      // Un envio justo despues de lanzar espera a que la CLI dibuje su pantalla (§10.11).
      const startAfterMs = submitStartDelayMs(deps.launchedAtOf(terminalId), deps.now(), input.readyAfterLaunchMs ?? 0);
      // Lo escrito en la caja de la CLI se aparta antes de pegar: si no, sale junto (§5.3.1).
      const aside: DraftAside =
        request.send && input.draftStash !== undefined
          ? await setCliDraftAside(input.draftStash, {
              screen: () => deps.watchScreen(terminalId),
              press: (key) => lane.writePieces([key], 0, request.write, plan.pieceGuard, { startAfterMs }),
              wait: deps.wait ?? delay,
              now: () => deps.now(),
            })
          : { kind: 'clear' };
      if (aside.kind === 'kept' || aside.kind === 'stuck') {
        result = { kind: 'cli-draft' };
        return;
      }
      let outcome: WriteOutcome;
      if (aside.kind === 'not-written') {
        outcome = aside.outcome;
      } else {
        // Antes de la primera escritura: quien busca la sesion por este texto no
        // puede encontrar el archivo de la CLI antes que el texto.
        deps.noteSubmitted(terminalId, fullText);
        outcome = await lane.writePieces(pieces, input.pieceGapMs, request.write, plan.pieceGuard, {
          startAfterMs: aside.kind === 'set-aside' ? 0 : startAfterMs,
        });
      }
      request.onWritten?.(outcome);
      /*
        La burbuja del mensaje mandado, hasta que el agente lo lea. Un comando de
        barra no es un mensaje del hilo: ni cola ni burbuja. Con el agente
        trabajando y una CLI que hace cola, espera en la cola: la que lleva la app
        (hito 45, `source: 'app'`) o la que escribe la CLI, que ya la muestra.
        Si no, sale "enviado" (§6.35.2).
      */
      if (outcome === 'written' && request.send && !request.text.trimStart().startsWith('/')) {
        const sent = { text: request.text, images: request.imageCount, at: deps.now() };
        const queued = deps.activityOf(terminalId) === 'busy' && plan.promptQueueSource !== null;
        if (queued && plan.promptQueueSource === 'app') deps.conversations.noteQueued(terminalId, sent);
        else if (!queued) deps.conversations.noteSent(terminalId, sent);
      }
      // La CLI que devuelve a su editor lo que tenia en cola al interrumpir (hito 43).
      if (outcome === 'written' && request.send && plan.hasQueuedSubmits) {
        deps.queuedSubmits.note(terminalId, submissionPayload(fullText, imagePaths, input.imageReference) ?? fullText, deps.now(), fullText);
      }
      if (outcome === 'written') result = { kind: 'written' };
      else if (outcome === 'refused') result = { kind: 'refused' };
      else if (outcome === 'interrupted') result = { kind: 'interrupted' };
      else {
        result = {
          kind: 'blocked',
          byDialog: plan.stoppedByDialog(),
          waitingNow: plan.blocksWhileWaiting && deps.activityOf(terminalId) === 'waiting',
        };
      }
    },
    // Descartado por una interrupcion antes de empezar: queda `dropped`.
    { onDropped: () => undefined },
  );
  return result;
}
