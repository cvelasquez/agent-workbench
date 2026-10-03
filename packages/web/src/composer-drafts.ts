/**
 * Lo escrito en el cuadro de cada pestana y todavia no mandado (§6.29).
 *
 * Dos memorias, y conviene no mezclarlas:
 *
 *  - **La de la pagina** (`get` y `put`): el texto y todas las fichas, imagenes
 *    incluidas. Es lo que hace que cambiar de pestana, o de ancho (§6.25), no
 *    cueste el mensaje a medio escribir. Vivia en `Composer.tsx`; vive aca
 *    porque el cuadro no esta montado sin pestanas, y los borradores del
 *    servidor llegan al conectar.
 *  - **La del servidor**: el texto y los textos pegados, despues de una pausa
 *    del teclado, para que sobrevivan a cerrar la app (mejoras de la 0.4.0).
 *    Vuelven al conectar (`restore`) y van al cuadro de una pestana que en esta
 *    pagina nadie toco: lo escrito aca no se pisa.
 *
 * "Tocada" es haber cambiado lo que se guarda, o haber mandado. Lo segundo
 * cuenta por una carrera: al reconectar, el servidor puede contestar con el
 * borrador antes de procesar el envio que estaba en la cola, y el mensaje ya
 * mandado volveria al cuadro.
 *
 * **No se manda nada hasta saber que el servidor los guarda**: el primer
 * `composer.drafts` de cada conexion lo dice. Uno anterior contestaria cada
 * pausa del teclado con un cartel de mensaje invalido. Lo que espera sale con
 * ese mensaje.
 *
 * Sin React ni DOM: lo prueba `check-composer-drafts.mjs` con un reloj de
 * mentira.
 */

import {
  composerDraftChars,
  isEmptyComposerDraft,
  MAX_COMPOSER_DRAFT_CHARS,
  sameComposerDraft,
  type ComposerDraft,
  type ComposerDraftEntry,
  type TerminalId,
} from '@agent-workbench/shared';
import { pastedLineCount } from './composer-paste.js';
import type { Attachment } from './useComposerAttachments.js';

/** Cuanto se espera despues de la ultima tecla para guardar. */
export const DRAFT_SAVE_DELAY_MS = 800;

/** Lo escrito en una pestana, tal como esta en el cuadro. */
export interface LocalDraft {
  text: string;
  items: Attachment[];
}

/** Lo que se guarda de lo escrito: el texto y los textos pegados, sin imagenes ni archivos. */
export function draftOf(local: LocalDraft): ComposerDraft {
  return {
    text: local.text,
    pasted: local.items.flatMap((item) => (item.kind === 'text' ? [{ number: item.number, text: item.text }] : [])),
  };
}

/** Un borrador guardado, de vuelta como fichas del cuadro. */
export function localDraftOf(draft: ComposerDraft, newId: () => string): LocalDraft {
  return {
    text: draft.text,
    items: draft.pasted.map((paste) => ({
      id: newId(),
      kind: 'text' as const,
      number: paste.number,
      text: paste.text,
      lines: pastedLineCount(paste.text),
    })),
  };
}

/**
 * Donde estaba el cursor del cuadro en una pestana, y hasta donde se habia
 * desplazado (0.5.0). Solo en la pagina: no va al servidor ni sobrevive a una
 * recarga.
 *
 * El cuadro es uno solo y cambia de texto con la pestana. Sin esto, al volver
 * quedaba mostrando el principio del texto, con el cursor invisible al final:
 * el usuario leyo una lista que parecia terminar en el punto 4 y siguio
 * numerando desde ahi.
 */
export interface DraftView {
  selectionStart: number;
  selectionEnd: number;
  /** La seleccion se hizo hacia atras (`selectionDirection` 'backward'). */
  backward: boolean;
  scrollTop: number;
}

/** Lo que el cuadro tiene que poner al volver a una pestana. `'end'` es "bajar hasta el cursor, al final". */
export interface RestoredView {
  start: number;
  end: number;
  direction: 'forward' | 'backward';
  scrollTop: number | 'end';
}

/**
 * Donde dejar el cursor y el scroll al volver a una pestana: lo recordado, sin
 * pasar del texto que hay; o, si no hay nada recordado —un borrador que llego
 * del servidor, una pestana que nunca se miro—, el cursor al final y el cuadro
 * abajo, donde se sigue escribiendo.
 */
export function viewToRestore(textLength: number, view: DraftView | undefined): RestoredView {
  if (view === undefined) return { start: textLength, end: textLength, direction: 'forward', scrollTop: 'end' };
  const clamp = (value: number): number => Math.min(Math.max(0, value), textLength);
  const start = clamp(view.selectionStart);
  const end = Math.max(start, clamp(view.selectionEnd));
  return { start, end, direction: view.backward ? 'backward' : 'forward', scrollTop: Math.max(0, view.scrollTop) };
}

/** Pasa del tope: no se puede guardar, y el cuadro lo avisa. */
export function draftTooLong(local: LocalDraft): boolean {
  return composerDraftChars(draftOf(local)) > MAX_COMPOSER_DRAFT_CHARS;
}

/** Dos borradores que guardan lo mismo. Vacio y ausente son lo mismo: no guardan nada. */
function equivalent(a: ComposerDraft | undefined, b: ComposerDraft): boolean {
  if (a === undefined || isEmptyComposerDraft(a)) return isEmptyComposerDraft(b);
  return sameComposerDraft(a, b);
}

function isBlank(local: LocalDraft | undefined): boolean {
  return local === undefined || (local.text.trim().length === 0 && local.items.length === 0);
}

const NOTHING: ComposerDraft = { text: '', pasted: [] };

export interface ComposerDraftsDeps {
  send: (terminalId: TerminalId, draft: ComposerDraft) => void;
  /** true con el socket abierto: cerrado, lo que habia que mandar espera. */
  connected: () => boolean;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  newId: () => string;
  delayMs?: number;
}

export class ComposerDrafts {
  private readonly local = new Map<TerminalId, LocalDraft>();
  /** El cursor y el scroll de cada pestana, al dejarla (`DraftView`). */
  private readonly views = new Map<TerminalId, DraftView>();
  /** Lo que el servidor tiene de cada pestana, hasta donde se sabe. */
  private readonly saved = new Map<TerminalId, ComposerDraft>();
  private readonly touched = new Set<TerminalId>();
  /** Lo que espera la pausa, o saber que el servidor guarda (`handle` null). */
  private readonly pending = new Map<TerminalId, { handle: unknown; draft: ComposerDraft }>();
  private readonly listeners = new Set<(terminalId: TerminalId) => void>();
  /** El servidor de esta conexion guarda borradores: ya llego su `composer.drafts`. */
  private serverKeeps = false;

  constructor(private readonly deps: ComposerDraftsDeps) {}

  /** Lo escrito en una pestana, o undefined si nunca se escribio nada. */
  get(terminalId: TerminalId): LocalDraft | undefined {
    return this.local.get(terminalId);
  }

  /** Lo escrito en una pestana cambio: queda en la pagina y, pasada la pausa, va al servidor. */
  put(terminalId: TerminalId, local: LocalDraft): void {
    this.local.set(terminalId, local);
    this.schedule(terminalId, draftOf(local));
  }

  /** Donde quedo el cursor del cuadro al dejar la pestana. */
  rememberView(terminalId: TerminalId, view: DraftView): void {
    this.views.set(terminalId, view);
  }

  /** Lo recordado de una pestana, o undefined si no hay nada que valga para su texto de ahora. */
  viewOf(terminalId: TerminalId): DraftView | undefined {
    return this.views.get(terminalId);
  }

  /**
   * Se mando lo del cuadro. El servidor borra lo guardado al recibir el envio,
   * asi que aca solo se olvida lo que esperaba salir: saldria el mensaje ya
   * mandado.
   */
  submitted(terminalId: TerminalId): void {
    this.cancel(terminalId);
    this.local.delete(terminalId);
    this.views.delete(terminalId);
    this.saved.delete(terminalId);
    this.touched.add(terminalId);
  }

  /**
   * Los borradores que tiene el servidor (`composer.drafts`). Van a la pagina
   * los de pestanas que nadie toco y que no tienen nada escrito; avisa de esos.
   */
  restore(entries: readonly ComposerDraftEntry[]): void {
    this.serverKeeps = true;
    const applied: TerminalId[] = [];
    for (const { terminalId, draft } of entries) {
      /*
        Una tocada manda lo suyo, y lo que el servidor diga de ella no cambia lo
        que se sabe: lo que habia en la cola de la conexion ya lo alcanza.
      */
      if (this.touched.has(terminalId)) continue;
      this.saved.set(terminalId, draft);
      if (!isBlank(this.local.get(terminalId))) continue;
      this.local.set(terminalId, localDraftOf(draft, this.deps.newId));
      // El texto cambio desde afuera: el cursor recordado era de otro texto.
      this.views.delete(terminalId);
      applied.push(terminalId);
    }
    for (const terminalId of applied) {
      for (const listener of this.listeners) listener(terminalId);
    }
    // Lo que esperaba a saber si este servidor los guarda.
    for (const [terminalId, entry] of [...this.pending]) {
      if (entry.handle === null) this.sendNow(terminalId);
    }
  }

  /** Se reconecto: puede ser otro servidor, y hasta que diga que guarda no se le manda nada. */
  reconnected(): void {
    this.serverKeeps = false;
  }

  /** Solo quedan estas pestanas: lo de las demas se olvida, y lo que esperaba salir no sale. */
  retain(terminalIds: readonly TerminalId[]): void {
    const keep = new Set(terminalIds);
    for (const terminalId of new Set([
      ...this.local.keys(),
      ...this.views.keys(),
      ...this.saved.keys(),
      ...this.touched,
      ...this.pending.keys(),
    ])) {
      if (keep.has(terminalId)) continue;
      this.cancel(terminalId);
      this.local.delete(terminalId);
      this.views.delete(terminalId);
      this.saved.delete(terminalId);
      this.touched.delete(terminalId);
    }
  }

  /** La pagina se va o se esconde: lo que esperaba la pausa sale ya. */
  flushAll(): void {
    for (const terminalId of [...this.pending.keys()]) this.sendNow(terminalId);
  }

  /** Avisa cuando llega del servidor el borrador de una pestana. Devuelve como dejar de escuchar. */
  onRestored(listener: (terminalId: TerminalId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private schedule(terminalId: TerminalId, draft: ComposerDraft): void {
    const waiting = this.pending.get(terminalId);
    if (waiting !== undefined && sameComposerDraft(waiting.draft, draft)) return;
    this.cancel(terminalId);
    // Volvio a lo que el servidor ya tiene: no hay nada que mandar.
    if (equivalent(this.saved.get(terminalId), draft)) return;
    this.touched.add(terminalId);
    const handle = this.deps.setTimer(() => this.sendNow(terminalId), this.deps.delayMs ?? DRAFT_SAVE_DELAY_MS);
    this.pending.set(terminalId, { handle, draft });
  }

  private cancel(terminalId: TerminalId): void {
    const waiting = this.pending.get(terminalId);
    if (waiting === undefined) return;
    if (waiting.handle !== null) this.deps.clearTimer(waiting.handle);
    this.pending.delete(terminalId);
  }

  private sendNow(terminalId: TerminalId): void {
    const waiting = this.pending.get(terminalId);
    if (waiting === undefined) return;
    // Lo llama la pausa, o alguien que no la espera (`flushAll`, `restore`): no queda armada.
    if (waiting.handle !== null) this.deps.clearTimer(waiting.handle);
    if (!this.serverKeeps || !this.deps.connected()) {
      // Espera a que un servidor diga que guarda borradores (`restore`).
      this.pending.set(terminalId, { handle: null, draft: waiting.draft });
      return;
    }
    this.pending.delete(terminalId);
    // Lo que pasa del tope no se guarda, y lo viejo tampoco se queda: se borra.
    const draft = composerDraftChars(waiting.draft) > MAX_COMPOSER_DRAFT_CHARS ? NOTHING : waiting.draft;
    if (equivalent(this.saved.get(terminalId), draft)) return;
    this.deps.send(terminalId, draft);
    if (isEmptyComposerDraft(draft)) this.saved.delete(terminalId);
    else this.saved.set(terminalId, draft);
  }
}
