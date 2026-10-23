/**
 * Los mensajes del usuario que esperan en la cola de Claude Code (hito 45,
 * §4.4.3).
 *
 * Con el agente trabajando, la CLI no le pasa lo que se le escribe: lo deja en
 * su cola ("ctrl+x ctrl+s to send now") y lo entrega cuando el turno puede
 * leerlo. Hasta entonces el hilo no tenia nada que mostrar: el mensaje aparecia
 * recien al entregarse, en el historial de esta maquina a los 12 s de mediana y
 * hasta 7,4 min despues de mandarlo.
 *
 * Lo que la CLI escribe, medido con la 2.1.301 (`docs/herramientas/cola/`, c11
 * y c12), cada linea a los 130-150 ms de la tecla:
 *
 * ```
 * queue-operation enqueue {content}     se mando con el agente trabajando
 * queue-operation popAll  {content}     la flecha arriba lo devolvio a la caja (uno por mensaje)
 * queue-operation remove  {content, reason: "absorbed_mid_turn"}   lo entrego a mitad del turno
 * queue-operation dequeue {}            lo entrego al terminar el turno: el primero de la cola
 * ```
 *
 * El modelo se sostiene en todo el historial de la maquina (233 archivos): los
 * 466 `remove` encuentran su `enqueue`, y ningun archivo termina con un mensaje
 * del usuario en cola. Por la misma cola pasan los avisos que se manda el
 * propio agente (`<task-notification>`, `<agent-message>`): cuentan para el
 * orden del `dequeue`, pero no son del usuario y no se muestran.
 *
 * Solo los del proceso de ahora: la cola vive en la memoria de la CLI, y un
 * `enqueue` de un proceso que murio no se va a entregar nunca. Es el mismo
 * corte que los subagentes (§4.15).
 */

import { MAX_QUEUED_PROMPT_CHARS, MAX_QUEUED_PROMPTS, type QueuedPrompt } from '@agent-workbench/shared';
import { cleanUserText, readTimestamp, takePastedImages } from './jsonl-events.js';

/**
 * Cuantos se recuerdan a la vez, contando los avisos del agente. Se van al
 * entregarse, asi que esto solo pesa si una version deja de escribir la salida:
 * ahi se descartan los mas viejos.
 */
const MAX_TRACKED = 100;

/** Lo que el agente se manda a si mismo por la misma cola: no lo escribio el usuario. */
const AGENT_NOTICE = /^\s*<(task-notification|agent-message)\b/;

interface Queued {
  seq: number;
  content: string;
  at: number;
}

/**
 * El texto entero de un mensaje en cola, como lo escribio el usuario: sin el
 * envoltorio de lo pegado y sin las imagenes, que se cuentan aparte. null si no
 * es suyo (un aviso del agente).
 */
export function queuedUserText(content: string): { text: string; images: number } | null {
  if (AGENT_NOTICE.test(content)) return null;
  const { text, images } = takePastedImages(cleanUserText(content));
  return { text: text.trim(), images: images.length };
}

/** El texto de un mensaje en cola tal como lo ve el usuario, o null si no es suyo. */
export function queuedPromptOf(content: string, id: string, at: number): QueuedPrompt | null {
  const user = queuedUserText(content);
  if (user === null) return null;
  const { text, images } = user;
  if (text.length === 0 && images === 0) return null;
  return {
    id,
    text: text.slice(0, MAX_QUEUED_PROMPT_CHARS),
    truncated: text.length > MAX_QUEUED_PROMPT_CHARS,
    images,
    at,
  };
}

export class PromptQueueTracker {
  private queue: Queued[] = [];
  private seq = 0;

  /** Una linea del JSONL, ya parseada. Nunca lanza: el esquema cambia. */
  observe(record: Record<string, unknown>): void {
    if (record['type'] !== 'queue-operation') return;
    const operation = record['operation'];
    const content = typeof record['content'] === 'string' ? record['content'] : null;

    if (operation === 'enqueue') {
      if (content === null) return;
      this.seq += 1;
      this.queue.push({ seq: this.seq, content, at: readTimestamp(record['timestamp']) });
      if (this.queue.length > MAX_TRACKED) this.queue.shift();
      return;
    }
    if (operation === 'dequeue') {
      this.queue.shift();
      return;
    }
    // `remove`, `popAll` o una operacion nueva: sale el de ese texto, si lo nombra.
    if (content === null) return;
    const index = this.queue.findIndex((item) => item.content === content);
    if (index !== -1) this.queue.splice(index, 1);
  }

  /**
   * Los mensajes del usuario en cola del proceso lanzado en `launchedAt` o
   * despues, en orden. Uno sin hora no se puede atribuir a ningun proceso y no
   * cuenta.
   *
   * Lo de un proceso anterior ademas se olvida: quedo en una cola que ya no
   * existe, y si siguiera adelante el `dequeue` del proceso de ahora sacaria
   * ese en vez del suyo.
   */
  pending(launchedAt: number): QueuedPrompt[] {
    this.queue = this.queue.filter((item) => item.at > 0 && item.at >= launchedAt);
    const result: QueuedPrompt[] = [];
    for (const item of this.queue) {
      const prompt = queuedPromptOf(item.content, `queue-${item.seq}`, item.at);
      if (prompt !== null) result.push(prompt);
      if (result.length >= MAX_QUEUED_PROMPTS) break;
    }
    return result;
  }

  /** El archivo se reemplazo: lo anotado era de otra lectura. */
  reset(): void {
    this.queue = [];
  }
}
