/**
 * Lo que la app le mando a una CLI libre, hasta que el agente empieza a
 * contestarlo (§6.35.2): la burbuja "enviado".
 *
 * Pedido del usuario el 28-10-2026: un mensaje mandado con el agente libre no
 * se veia en el hilo hasta que la CLI lo escribia, mientras la solapa CLI ya lo
 * mostraba. Que salga al instante, como el que espera en la cola (§6.35), y que
 * se pueda corregir mientras el agente no empezo.
 *
 * Una entrada pasa por dos momentos:
 *
 *  - **Todavia no esta en el hilo**: la burbuja la dibuja la app con lo que
 *    mando.
 *  - **Ya esta en el hilo y el agente no escribio nada despues**: la entrada
 *    lleva el `eventId` del mensaje, el hilo lo esconde de su lugar y la
 *    burbuja sigue al final, que es el mismo lugar. Mientras dure, Claude Code
 *    devuelve el mensaje si se la detiene (§4.16, medido tambien pensando con
 *    esfuerzo maximo), y por eso ahi esta "Editar".
 *
 * Sale cuando aparece cualquier evento despues de su mensaje (el agente
 * empezo, o la CLI marco la interrupcion), cuando su mensaje deja de verse
 * (Detener lo devolvio al cuadro y el hilo lo escondio), o cuando el hub la da
 * por perdida: sin proceso, o la CLI libre sin haberlo escrito.
 *
 * Puro: lo prueba `check-thread-status.mjs` sin pty.
 */

import {
  MAX_QUEUED_PROMPT_CHARS,
  MAX_QUEUED_PROMPTS,
  type ConversationEvent,
  type QueuedPrompt,
  type TerminalId,
} from '@agent-workbench/shared';
import { CLOCK_SLACK_MS, matches, userTextOf } from './app-prompt-queue.js';

interface Entry {
  id: string;
  /** El texto del cuadro, sin las referencias a sus adjuntos: lo que se muestra y con lo que se reconoce. */
  text: string;
  images: number;
  at: number;
  /** El mensaje del hilo que ya es este, o null si la CLI todavia no lo escribio. */
  eventId: string | null;
}

export class SentPrompts {
  private readonly byTerminal = new Map<TerminalId, Entry[]>();
  private seq = 0;

  /** La app termino de escribirle un mensaje a la CLI libre. */
  note(terminalId: TerminalId, input: { text: string; images: number; at: number }): void {
    if (input.text.trim().length === 0 && input.images === 0) return;
    this.seq += 1;
    const entries = this.byTerminal.get(terminalId) ?? [];
    entries.push({ id: `sent-${this.seq}`, text: input.text, images: input.images, at: input.at, eventId: null });
    this.byTerminal.set(terminalId, entries.slice(-MAX_QUEUED_PROMPTS));
  }

  /**
   * Mira el final del hilo (`events`, en orden): cada entrada reconoce su
   * mensaje, la mas vieja primero, y sale si despues de el hay algo o si ya no
   * se ve. true si cambio algo.
   */
  settle(terminalId: TerminalId, events: readonly ConversationEvent[]): boolean {
    const entries = this.byTerminal.get(terminalId);
    if (entries === undefined || entries.length === 0) return false;
    const used = new Set(entries.flatMap((entry) => (entry.eventId === null ? [] : [entry.eventId])));
    let changed = false;
    const remaining: Entry[] = [];
    for (const entry of entries) {
      let eventId = entry.eventId;
      if (eventId === null) {
        for (const event of events) {
          if (used.has(event.eventId) || event.at < entry.at - CLOCK_SLACK_MS) continue;
          const message = userTextOf(event);
          if (message === null || !matches(entry, message)) continue;
          used.add(event.eventId);
          eventId = event.eventId;
          break;
        }
        if (eventId === null) {
          remaining.push(entry);
          continue;
        }
      }
      const index = events.findIndex((event) => event.eventId === eventId);
      // Algo despues de su mensaje, o el mensaje ya no se ve: el agente empezo, o Detener lo devolvio.
      if (index === -1 || index < events.length - 1) {
        changed = true;
        continue;
      }
      if (eventId !== entry.eventId) changed = true;
      remaining.push({ ...entry, eventId });
    }
    if (changed) this.set(terminalId, remaining);
    return changed;
  }

  /**
   * Las que se mandaron antes de `before`. Lo usa el hub con la CLI libre: una
   * mandada antes de que quedara libre ya no va a empezar. true si habia alguna.
   */
  dropBefore(terminalId: TerminalId, before: number): boolean {
    const entries = this.byTerminal.get(terminalId);
    if (entries === undefined) return false;
    const remaining = entries.filter((entry) => entry.at >= before);
    if (remaining.length === entries.length) return false;
    this.set(terminalId, remaining);
    return true;
  }

  /** Ninguna sigue: la pestana quedo sin proceso o libre, o Detener las devolvio al cuadro. true si habia alguna. */
  clear(terminalId: TerminalId): boolean {
    const had = (this.byTerminal.get(terminalId)?.length ?? 0) > 0;
    this.byTerminal.delete(terminalId);
    return had;
  }

  /** `editable`: la CLI de la pestana devuelve el mensaje si se la detiene antes de que el agente empiece. */
  list(terminalId: TerminalId, editable: boolean): QueuedPrompt[] {
    return (this.byTerminal.get(terminalId) ?? []).map((entry) => {
      const text = entry.text.trim();
      const prompt: QueuedPrompt = {
        id: entry.id,
        text: text.slice(0, MAX_QUEUED_PROMPT_CHARS),
        truncated: text.length > MAX_QUEUED_PROMPT_CHARS,
        images: entry.images,
        at: entry.at,
        sent: true,
      };
      if (entry.eventId !== null) prompt.eventId = entry.eventId;
      if (editable) prompt.editable = true;
      return prompt;
    });
  }

  private set(terminalId: TerminalId, entries: Entry[]): void {
    if (entries.length === 0) this.byTerminal.delete(terminalId);
    else this.byTerminal.set(terminalId, entries);
  }
}
