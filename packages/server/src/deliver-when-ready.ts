/**
 * Mandarle un texto a la CLI de una pestana cuando esta lista (hito 29, M3).
 *
 * Es lo que hacia `notes.send` adentro del socket, extraido con sus
 * dependencias inyectadas para que lo usen dos caminos —una nota y la
 * continuacion de una conversacion en otra CLI— y para que el chequeo lo pruebe
 * sin socket y sin pty. **Nada del camino de las notas cambia**: el mismo orden
 * de comprobaciones, la misma espera, la misma fila y las mismas piezas; los
 * textos de error siguen en el socket.
 *
 * Tres reglas, cada una por algo que ya se sabe que pasa:
 *
 *  - **Sin senal de "lista" no se escribe nada** (`readySignal`). Una pty recien
 *    abierta puede estar pintando, y ahi el pegado se pierde o contesta un menu.
 *  - **La espera queda fuera de la fila.** Es una espera por la CLI, no una
 *    escritura: lo que se le mande a la pestana mientras tanto no tiene por que
 *    quedar quince segundos detras.
 *  - **La sesion se espera por aviso del registro, no por sondeo.** Una CLI con
 *    senal de "lista" pero que pone el id ella misma gana la sesion despues de
 *    lanzar; hoy no hay ninguna, y con Claude Code el id esta desde el principio.
 */

import type { AgentAdapter } from './agents/adapter.js';
import type { ComposerPrefillReason, TerminalDescriptor, TerminalId } from '@agent-workbench/shared';
import { buildSubmissionWrites } from './pty-input.js';
import type { EnqueueOptions, PieceWriter, WriteLane } from './terminal-write-queue.js';

export interface DeliverDeps {
  /** El descriptor de ahora, o null si la pestana ya no existe. */
  describe(terminalId: TerminalId): Pick<TerminalDescriptor, 'kind' | 'sessionId'> | null;
  /** Cada cambio del registro (`changed`). Devuelve la desuscripcion. */
  onChanged(listener: () => void): () => void;
  /** La CLI de la pestana: su senal de "lista", su estado y como se le escribe. */
  adapterOf(terminalId: TerminalId): Pick<AgentAdapter, 'capabilities' | 'status' | 'input'> | null;
  /** Guarda una imagen y devuelve su ruta (`PasteStore.save`). */
  saveImage(terminalId: TerminalId, mediaType: string, data: string): Promise<string>;
  /** Antes de la primera escritura (`TerminalRegistry.noteSubmitted`). */
  noteSubmitted(terminalId: TerminalId, text: string): void;
  /** La fila de la terminal (`TerminalWriteQueue.enqueue`). */
  enqueue(terminalId: TerminalId, job: (lane: WriteLane) => Promise<void>, options?: EnqueueOptions): Promise<void>;
  /**
   * El plazo de la espera de la sesion. Devuelve como cancelarlo. Inyectable
   * para el chequeo, que no puede esperar quince segundos de verdad.
   */
  setTimer?: (callback: () => void, ms: number) => () => void;
}

export interface DeliverRequest {
  terminalId: TerminalId;
  text: string;
  images: readonly { mediaType: string; data: string }[];
  /** Cuanto se espera, cada vez: a que la pestana tenga sesion y a que la CLI este lista. */
  timeoutMs: number;
  /** Escribe una pieza en la pty. false si no la acepto. */
  write: PieceWriter;
}

/**
 * Como termino. Un solo `sent` es exito; lo demas dice por que no se escribio
 * todo, y quien llama decide el texto.
 *
 *  - `nothing`: no habia nada que mandar (`buildSubmissionWrites` null).
 *  - `gone`: la pestana ya no existe. `no-agent`: no es de agente.
 *  - `no-session`: no gano sesion en el plazo. Nada escrito.
 *  - `no-ready-signal`: su CLI no avisa cuando esta lista. Nada escrito.
 *  - `no-images`: trae imagenes y su CLI no las recibe. Nada escrito.
 *  - `not-ready`: la CLI no llego a "lista" en el plazo. Nada escrito.
 *  - `image-failed`: no se pudo guardar una imagen. Nada escrito.
 *  - `interrupted`: una interrupcion lo descarto o lo corto.
 *  - `refused`: la terminal no acepto una pieza (se durmio o se cerro).
 */
export type DeliverOutcome =
  | { kind: 'sent' }
  | { kind: 'nothing' }
  | { kind: 'gone' }
  | { kind: 'no-agent' }
  | { kind: 'no-session' }
  | { kind: 'no-ready-signal' }
  | { kind: 'no-images' }
  | { kind: 'not-ready' }
  | { kind: 'image-failed'; detail: string }
  | { kind: 'interrupted' }
  | { kind: 'refused' };

const defaultTimer = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

type SessionWait = 'ok' | 'gone' | 'no-agent' | 'timeout';

/** Hasta que la pestana tenga id de sesion, por aviso del registro y con plazo. */
function waitForSession(deps: DeliverDeps, terminalId: TerminalId, timeoutMs: number): Promise<SessionWait> {
  const current = (): SessionWait | null => {
    const descriptor = deps.describe(terminalId);
    if (descriptor === null) return 'gone';
    if (descriptor.kind !== 'agent') return 'no-agent';
    return descriptor.sessionId.length > 0 ? 'ok' : null;
  };
  const now = current();
  if (now !== null) return Promise.resolve(now);

  return new Promise((resolve) => {
    let done = false;
    let stopListening: () => void = () => undefined;
    let cancelTimer: () => void = () => undefined;
    const finish = (value: SessionWait): void => {
      if (done) return;
      done = true;
      stopListening();
      cancelTimer();
      resolve(value);
    };
    stopListening = deps.onChanged(() => {
      const value = current();
      if (value !== null) finish(value);
    });
    // Un temporizador que dispara en el acto (el del chequeo) ya encontro todo armado.
    if (!done) cancelTimer = (deps.setTimer ?? defaultTimer)(() => finish('timeout'), timeoutMs);
    if (done) {
      stopListening();
      cancelTimer();
    }
  });
}

/**
 * Espera a que la pestana tenga sesion y su CLI este lista, y escribe el texto
 * por la fila de la terminal, como un mensaje del cuadro.
 *
 * El orden de las comprobaciones es el de `notes.send` antes del hito 29:
 * pestana, sesion, senal de "lista", imagenes, "lista", y recien ahi la fila.
 */
export async function deliverWhenReady(deps: DeliverDeps, request: DeliverRequest): Promise<DeliverOutcome> {
  const { terminalId, text, images } = request;

  const session = await waitForSession(deps, terminalId, request.timeoutMs);
  if (session === 'gone') return { kind: 'gone' };
  if (session === 'no-agent') return { kind: 'no-agent' };
  if (session === 'timeout') return { kind: 'no-session' };

  const adapter = deps.adapterOf(terminalId);
  const status = adapter?.capabilities.readySignal === true ? adapter.status : null;
  if (adapter === null || status === null) return { kind: 'no-ready-signal' };
  if (images.length > 0 && adapter.input.imageReference === null) return { kind: 'no-images' };

  const sessionId = deps.describe(terminalId)?.sessionId ?? '';
  if (sessionId.length === 0) return { kind: 'gone' };
  if (!(await status.waitUntilReady(sessionId, request.timeoutMs))) return { kind: 'not-ready' };

  const input = adapter.input;
  let outcome: DeliverOutcome = { kind: 'interrupted' };
  await deps.enqueue(
    terminalId,
    async (lane) => {
      const imagePaths: string[] = [];
      try {
        for (const image of images) imagePaths.push(await deps.saveImage(terminalId, image.mediaType, image.data));
      } catch (error) {
        outcome = { kind: 'image-failed', detail: error instanceof Error ? error.message : String(error) };
        return;
      }

      const pieces = buildSubmissionWrites(text, imagePaths, input);
      if (pieces === null) {
        outcome = { kind: 'nothing' };
        return;
      }
      // Antes de la primera escritura: quien busca la sesion por este texto no
      // puede encontrar el archivo de la CLI antes que el texto.
      deps.noteSubmitted(terminalId, text);
      const written = await lane.writePieces(pieces, input.pieceGapMs, request.write);
      outcome =
        written === 'written'
          ? { kind: 'sent' }
          : written === 'interrupted'
            ? { kind: 'interrupted' }
            : { kind: 'refused' };
    },
    // Descartado por una interrupcion antes de empezar: queda `interrupted`.
    { onDropped: () => undefined },
  );
  return outcome;
}

/**
 * Que motivo lleva el `composer.prefill` de una continuacion que no se mando
 * sola, o null si no hay nada que prellenar.
 *
 * Lo que no llego a escribirse por la CLI —sin sesion, sin "lista"— es
 * `not-ready`; lo que se intento y fallo, `send-failed`. Una pestana que ya no
 * esta no tiene cuadro, y un envio completo no se prellena: el usuario empezaria
 * a editar lo que ya se mando (D19).
 */
export function prefillReasonFor(outcome: DeliverOutcome): ComposerPrefillReason | null {
  switch (outcome.kind) {
    case 'sent':
    case 'gone':
    case 'nothing':
      return null;
    case 'no-session':
    case 'not-ready':
      return 'not-ready';
    case 'no-agent':
    case 'no-ready-signal':
    case 'no-images':
    case 'image-failed':
    case 'interrupted':
    case 'refused':
      return 'send-failed';
  }
}
