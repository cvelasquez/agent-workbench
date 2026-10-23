/**
 * La cola de una CLI que no la escribe en ningun lado (hito 45, §6.35).
 *
 * Pi deja en cola lo que se le escribe con el agente trabajando ("Steering",
 * §16.5) y Antigravity tambien (§12.13), pero ninguna de las dos lo escribe
 * en un archivo que la app lea hasta entregarlo: Pi, en su sesion; Antigravity,
 * en el transcript, y medido, recien al cerrar el turno. Lo unico que la app
 * sabe es lo que **ella** les mando, y eso es esta cola.
 *
 * Una entrada sale:
 *
 *  - cuando su mensaje aparece en el hilo: un mensaje del usuario de despues de
 *    mandarlo, con su texto (`settle`);
 *  - cuando la pestana queda sin proceso, o libre un rato (lo decide el hub);
 *  - cuando Detener le devuelve el texto al cuadro (Pi, hito 43), o cuando el
 *    usuario la saca para editarla desde el hilo (§6.35.1).
 *
 * Lo que se escribe en la solapa CLI no pasa por aca, y la flecha arriba
 * tecleada ahi —que devuelve la cola a su editor— no deja rastro: la burbuja
 * sigue hasta que la CLI queda libre. Son los dos limites de esta fuente.
 *
 * Puro: lo prueba `check-pi-adapter.mjs` sin pty.
 */

import {
  MAX_QUEUED_PROMPT_CHARS,
  MAX_QUEUED_PROMPTS,
  type ConversationEvent,
  type QueuedPrompt,
  type TerminalId,
} from '@agent-workbench/shared';

/**
 * Cuanto antes del envio puede estar fechado su mensaje en el hilo: la hora de
 * la entrada es la de la app al terminar de escribir, y la del hilo, la de la
 * CLI al recibirlo.
 */
const CLOCK_SLACK_MS = 2_000;

interface Entry {
  id: string;
  /** El texto del cuadro, sin las referencias a sus adjuntos: lo que se muestra y con lo que se reconoce. */
  text: string;
  images: number;
  at: number;
  forced: boolean;
}

/** Lo que se compara: sin saltos ni espacios de mas. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** El texto de un mensaje del hilo, o null si no es un mensaje del usuario. */
function userTextOf(event: ConversationEvent): { text: string; images: number } | null {
  if (event.role !== 'user') return null;
  const texts: string[] = [];
  let images = 0;
  for (const part of event.parts) {
    if (part.kind === 'text') texts.push(part.text);
    else if (part.kind === 'image') images += 1;
    // Un resultado de herramienta o un comando no son un mensaje escrito.
    else if (part.kind === 'tool-result' || part.kind === 'tool-call') return null;
  }
  return { text: normalize(texts.join(' ')), images };
}

/** true si el mensaje del hilo es el de la entrada: su texto, o el texto con lo que la CLI le agrego. */
function matches(entry: Entry, message: { text: string; images: number }): boolean {
  const wanted = normalize(entry.text);
  if (wanted.length === 0) return message.text.length === 0 && message.images >= entry.images && entry.images > 0;
  // Recortado por el tope de transporte, el hilo trae el principio.
  return message.text === wanted || message.text.includes(wanted) || (message.text.length >= 200 && wanted.startsWith(message.text));
}

export class AppPromptQueue {
  private readonly byTerminal = new Map<TerminalId, Entry[]>();
  private seq = 0;

  /** La app termino de escribir un mensaje con el agente trabajando. */
  note(terminalId: TerminalId, input: { text: string; images: number; at: number }): void {
    if (input.text.trim().length === 0 && input.images === 0) return;
    this.seq += 1;
    const entries = this.byTerminal.get(terminalId) ?? [];
    entries.push({ id: `app-${this.seq}`, text: input.text, images: input.images, at: input.at, forced: false });
    this.byTerminal.set(terminalId, entries.slice(-MAX_QUEUED_PROMPTS));
  }

  /**
   * Saca las que ya aparecieron en el hilo. Cada mensaje del hilo se lleva una
   * sola entrada, la mas vieja que le corresponde. true si cambio algo.
   */
  settle(terminalId: TerminalId, events: readonly ConversationEvent[]): boolean {
    const entries = this.byTerminal.get(terminalId);
    if (entries === undefined || entries.length === 0) return false;
    const used = new Set<string>();
    const remaining = entries.filter((entry) => {
      for (const event of events) {
        if (used.has(event.eventId) || event.at < entry.at - CLOCK_SLACK_MS) continue;
        const message = userTextOf(event);
        if (message === null || !matches(entry, message)) continue;
        used.add(event.eventId);
        return false;
      }
      return true;
    });
    if (remaining.length === entries.length) return false;
    this.set(terminalId, remaining);
    return true;
  }

  /** Se forzo el envio: lo que esperaba ya se le esta pasando al agente. true si cambio algo. */
  markForced(terminalId: TerminalId): boolean {
    const entries = this.byTerminal.get(terminalId);
    if (entries === undefined || entries.every((entry) => entry.forced)) return false;
    this.set(terminalId, entries.map((entry) => ({ ...entry, forced: true })));
    return true;
  }

  /** Nada sigue en cola: la pestana quedo sin proceso o libre, o Detener lo devolvio al cuadro. true si habia algo. */
  clear(terminalId: TerminalId): boolean {
    const had = (this.byTerminal.get(terminalId)?.length ?? 0) > 0;
    this.byTerminal.delete(terminalId);
    return had;
  }

  /** Los textos enteros, en orden: lo que vuelve al cuadro al sacar la cola para editarla (§6.35.1). */
  texts(terminalId: TerminalId): string[] {
    return (this.byTerminal.get(terminalId) ?? []).map((entry) => entry.text.trim()).filter((text) => text.length > 0);
  }

  list(terminalId: TerminalId): QueuedPrompt[] {
    return (this.byTerminal.get(terminalId) ?? []).map((entry) => {
      const text = entry.text.trim();
      const prompt: QueuedPrompt = {
        id: entry.id,
        text: text.slice(0, MAX_QUEUED_PROMPT_CHARS),
        truncated: text.length > MAX_QUEUED_PROMPT_CHARS,
        images: entry.images,
        at: entry.at,
      };
      if (entry.forced) prompt.forced = true;
      return prompt;
    });
  }

  private set(terminalId: TerminalId, entries: Entry[]): void {
    if (entries.length === 0) this.byTerminal.delete(terminalId);
    else this.byTerminal.set(terminalId, entries);
  }
}
