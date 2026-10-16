/**
 * Lo que el menu de rewind de una CLI necesita saber del mensaje del hilo antes
 * del que se vuelve (hito 44, §4.16).
 *
 * Generico: lo arma el hub con los eventos que se ven, y el menu de cada CLI lo
 * usa a su manera. Puro: lo prueba `check-prompt-editing.mjs`.
 */

import type { ConversationEvent } from '@agent-workbench/shared';

export interface RewindTarget {
  /** El texto del mensaje, para el cuadro. */
  text: string;
  /** true si algun trozo llego recortado por el tope de transporte: hay que leerlo entero. */
  truncated: boolean;
  /** Su primera linea con texto, que es como lo muestra la CLI en su lista. */
  firstLine: string;
  /** Cuantos mensajes con esa misma primera linea hay desde este hasta el final, contandolo. */
  occurrence: number;
  /** Cuantos mensajes del usuario hay desde este hasta el final, contandolo. */
  promptsFromHere: number;
}

/** El texto de un mensaje que escribio el usuario, o null si el evento no es uno. */
export function promptTextOf(event: ConversationEvent): { text: string; truncated: boolean } | null {
  if (event.role !== 'user') return null;
  if (event.parts.some((part) => part.kind === 'tool-result' || part.kind === 'notice')) return null;
  const texts = event.parts.flatMap((part) => (part.kind === 'text' ? [part] : []));
  if (texts.length === 0 && !event.parts.some((part) => part.kind === 'image')) return null;
  return {
    text: texts.map((part) => part.text).join('\n'),
    truncated: texts.some((part) => part.truncated),
  };
}

/** La primera linea con texto. */
export function firstLineOf(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

const comparable = (line: string): string => line.replace(/\s+/g, ' ').trim();

/** El mensaje `eventId` de la lista, o null si no esta o no lo escribio el usuario. */
export function rewindTargetFrom(events: readonly ConversationEvent[], eventId: string): RewindTarget | null {
  const index = events.findIndex((event) => event.eventId === eventId);
  if (index === -1) return null;
  const event = events[index];
  const prompt = event === undefined ? null : promptTextOf(event);
  if (prompt === null) return null;
  const firstLine = firstLineOf(prompt.text);
  let occurrence = 0;
  let promptsFromHere = 0;
  for (const later of events.slice(index)) {
    const text = promptTextOf(later);
    if (text === null) continue;
    promptsFromHere += 1;
    if (comparable(firstLineOf(text.text)) === comparable(firstLine)) occurrence += 1;
  }
  return { text: prompt.text, truncated: prompt.truncated, firstLine, occurrence, promptsFromHere };
}
