/**
 * Los subagentes que lanzo una sesion de Claude Code y que todavia no
 * terminaron (§4.15).
 *
 * Existe por el que corre en segundo plano: el agente principal cierra su turno
 * y queda esperandolo, y el hilo parecia terminado. Medido el 29-09-2026 sobre
 * el historial de esta instalacion (44 lanzamientos en segundo plano, 2.1.2xx):
 *
 *  - Se lanza con una llamada `Agent` (`Task` en versiones viejas). Con
 *    `run_in_background: true` su `tool_result` llega enseguida, con
 *    `toolUseResult.status: "async_launched"` y el `agentId`: el subagente
 *    sigue trabajando.
 *  - Cuando termina, la CLI escribe **en el acto** una linea
 *    `queue-operation` `enqueue` con un `<task-notification>` que trae su
 *    `<tool-use-id>` y su `<status>`, este trabajando o no el agente principal.
 *    Despues el aviso le llega al agente como `queued_command` (si estaba
 *    trabajando) o como una linea `user` con `origin.kind:
 *    "task-notification"` (si estaba libre). Cualquiera de las tres lo da por
 *    terminado: la primera es la que llega antes.
 *  - Sin `run_in_background`, trabaja hasta que llega su `tool_result`.
 *
 * Lo que no se midio, y por eso no se hace: retomar con `SendMessage` uno que
 * ya habia terminado. Si eso lo vuelve a poner a trabajar, aca no se ve; es la
 * falla que conviene, porque la otra —suponerlo y que no sea— lo dejaria
 * "trabajando" para siempre.
 *
 * Los comandos de Bash en segundo plano mandan el mismo aviso y no se cuentan:
 * lo que se muestra son subagentes.
 */

import { MAX_SUBAGENT_DESCRIPTION, type ConversationSubagent } from '@agent-workbench/shared';
import { readTimestamp, recordOf } from './jsonl-events.js';

/** Los nombres de la herramienta que lanza un subagente. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * Cuantos se recuerdan a la vez. Los que terminan se olvidan, asi que esto solo
 * pesa si una version deja de avisar: ahi se descartan los mas viejos.
 */
const MAX_TRACKED = 50;

/** Un aviso de fin de tarea, con el `tool_use` que la lanzo. */
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TOOL_USE_ID = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/;

/** Una etiqueta de una linea: sin saltos ni blancos repetidos, y con tope. */
function labelOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SUBAGENT_DESCRIPTION);
}

/** Los `tool_use` que nombra cada `<task-notification>` del texto. */
export function notifiedToolUseIds(text: string): string[] {
  if (!text.includes('<task-notification>')) return [];
  const ids: string[] = [];
  for (const match of text.matchAll(NOTIFICATION)) {
    const id = TOOL_USE_ID.exec(match[1] ?? '')?.[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** El texto de un `message.content`: el string, o los bloques `text` juntos. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    const record = recordOf(block);
    if (record !== null && record['type'] === 'text' && typeof record['text'] === 'string') {
      text += record['text'];
    }
  }
  return text;
}

/** true si el resultado de la llamada dice que el subagente quedo andando solo. */
function launchedInBackground(toolUseResult: unknown): boolean {
  const result = recordOf(toolUseResult);
  return result !== null && (result['status'] === 'async_launched' || result['isAsync'] === true);
}

export class SubagentTracker {
  /** Los que no terminaron, en orden de lanzamiento (`Map` conserva el de insercion). */
  private readonly pending = new Map<string, ConversationSubagent>();

  /** Una linea del JSONL, ya parseada. Nunca lanza: el esquema cambia. */
  observe(record: Record<string, unknown>): void {
    // Una rama de subagente escrita en el archivo principal (versiones viejas):
    // sus propios subagentes no son los de esta conversacion.
    if (record['isSidechain'] === true) return;

    switch (record['type']) {
      case 'assistant':
        this.observeLaunches(record);
        return;
      case 'user':
        this.observeResults(record);
        this.finish(notifiedToolUseIds(contentText(recordOf(record['message'])?.['content'])));
        return;
      case 'queue-operation':
        // El `enqueue` es el que llega en el momento en que termino.
        if (record['operation'] === 'enqueue' && typeof record['content'] === 'string') {
          this.finish(notifiedToolUseIds(record['content']));
        }
        return;
      case 'attachment': {
        const attachment = recordOf(record['attachment']);
        if (attachment?.['type'] === 'queued_command' && typeof attachment['prompt'] === 'string') {
          this.finish(notifiedToolUseIds(attachment['prompt']));
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Los que siguen trabajando y los lanzo el proceso de `launchedAt` o uno
   * posterior. Uno sin hora no se puede atribuir a ningun proceso y no cuenta.
   */
  running(launchedAt: number): ConversationSubagent[] {
    const result: ConversationSubagent[] = [];
    for (const subagent of this.pending.values()) {
      if (subagent.startedAt > 0 && subagent.startedAt >= launchedAt) result.push({ ...subagent });
    }
    return result;
  }

  /** El archivo se reemplazo: lo anotado era de otra lectura. */
  reset(): void {
    this.pending.clear();
  }

  private observeLaunches(record: Record<string, unknown>): void {
    const content = recordOf(record['message'])?.['content'];
    if (!Array.isArray(content)) return;
    const startedAt = readTimestamp(record['timestamp']);
    for (const block of content) {
      const call = recordOf(block);
      if (call === null || call['type'] !== 'tool_use') continue;
      const toolUseId = call['id'];
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) continue;
      if (typeof call['name'] !== 'string' || !SUBAGENT_TOOLS.has(call['name'])) continue;
      if (this.pending.has(toolUseId)) continue;
      const input = recordOf(call['input']);
      this.pending.set(toolUseId, {
        toolUseId,
        description: labelOf(input?.['description']),
        background: input?.['run_in_background'] === true,
        startedAt,
      });
      // Tope: si una version deja de avisar, que no crezca con la sesion.
      if (this.pending.size > MAX_TRACKED) {
        const oldest = this.pending.keys().next();
        if (!oldest.done) this.pending.delete(oldest.value);
      }
    }
  }

  /**
   * El resultado de la llamada. En segundo plano dice que quedo andando, y
   * sigue; si no, termino —o no llego a lanzarse, que para el hilo es lo mismo—.
   */
  private observeResults(record: Record<string, unknown>): void {
    const content = recordOf(record['message'])?.['content'];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const result = recordOf(block);
      if (result === null || result['type'] !== 'tool_result') continue;
      const toolUseId = result['tool_use_id'];
      if (typeof toolUseId !== 'string') continue;
      const subagent = this.pending.get(toolUseId);
      if (subagent === undefined) continue;
      if (result['is_error'] !== true && launchedInBackground(record['toolUseResult'])) {
        subagent.background = true;
      } else {
        this.pending.delete(toolUseId);
      }
    }
  }

  private finish(toolUseIds: readonly string[]): void {
    for (const toolUseId of toolUseIds) this.pending.delete(toolUseId);
  }
}
