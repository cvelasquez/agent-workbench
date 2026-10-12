/**
 * El arbol de una sesion de Pi y su rama activa.
 *
 * Las entradas forman un arbol por `id` y `parentId` (CLAUDE.md 16.8): `/tree`
 * deja elegir un punto anterior, y lo siguiente se escribe al final del archivo
 * colgando de ese punto. **La conversacion en curso es el camino desde la ultima
 * linea hasta la raiz**; lo que quedo en la rama abandonada sigue en el archivo
 * y no se muestra.
 *
 * Por eso esto no puede ser el `JsonlLineSink` de siempre, que solo agrega: una
 * linea nueva que cuelga de otro punto obliga a rehacer el hilo entero. Se
 * guardan todas las entradas, y el estado que depende del camino —modelo,
 * razonamiento, duracion del turno, "en cola", medidor— se
 * calcula con un mismo paso (`step`), de a una entrada al agregar y de corrido
 * al rehacer.
 *
 * Puro, sin disco: lo prueba `check-pi-adapter.mjs`.
 */

import type { ConversationEvent, ConversationPart, MessageUsage } from '@agent-workbench/shared';
import { NOTICE_DETAIL_MAX_CHARS, type PiEntry, type PiUsage } from './session-entries.js';

/** Lo que el medidor necesita, sin la ventana: esa la pone el catalogo. */
export interface PiMeter {
  provider: string | null;
  modelId: string | null;
  /** El nivel de razonamiento vigente, o null si el archivo todavia no lo dijo. */
  effort: string | null;
  lastRequestTokens: number;
  lastOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  assistantMessages: number;
}

interface PathState {
  events: ConversationEvent[];
  dropped: number;
  meter: PiMeter;
  /** true desde un mensaje del usuario hasta la respuesta que cierra el turno. */
  inFlight: boolean;
  turnStartedAt: number | null;
}

function emptyState(): PathState {
  return {
    events: [],
    dropped: 0,
    meter: {
      provider: null,
      modelId: null,
      effort: null,
      lastRequestTokens: 0,
      lastOutputTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      assistantMessages: 0,
    },
    inFlight: false,
    turnStartedAt: null,
  };
}

/** `proveedor/modelo`, la forma con la que casa el combo y el catalogo; null si falta alguno. */
export function modelKey(provider: string | null, modelId: string | null): string | null {
  if (modelId === null || modelId.length === 0) return null;
  return provider === null || provider.length === 0 ? modelId : `${provider}/${modelId}`;
}

function messageUsage(usage: PiUsage): MessageUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheCreationInputTokens: usage.cacheWrite,
    cacheReadInputTokens: usage.cacheRead,
  };
}

function event(
  eventId: string,
  role: ConversationEvent['role'],
  at: number,
  parts: ConversationPart[],
  extra: Partial<Pick<ConversationEvent, 'model' | 'usage' | 'effort' | 'durationMs' | 'queued'>> = {},
): ConversationEvent {
  return {
    eventId,
    role,
    at,
    parts,
    model: extra.model ?? null,
    usage: extra.usage ?? null,
    effort: extra.effort ?? null,
    durationMs: extra.durationMs ?? null,
    queued: extra.queued ?? false,
  };
}

/**
 * Aplica una entrada al estado del camino. Devuelve los eventos que agrega.
 *
 * Dos reglas que no son evidentes:
 *
 *  - **Un mensaje del usuario con el turno en vuelo quedo en cola** (`queued`):
 *    Pi lo entrega cuando termina el paso en curso, asi que cuelga de un
 *    resultado o de una respuesta con llamadas, nunca de una que cerro el turno.
 *  - **Una respuesta interrumpida o con error trae el uso en cero** (16.3) y no
 *    cuenta para el medidor. Deja un aviso en el hilo, aparte de lo que alcanzo
 *    a escribir.
 */
function step(state: PathState, entry: PiEntry): ConversationEvent[] {
  const { fact } = entry;
  const added: ConversationEvent[] = [];

  switch (fact.kind) {
    // El nombre (`info`) no depende de la rama: lo lee `session-scan.ts` de la cola del archivo.
    case 'other':
    case 'info':
      break;

    case 'model':
      state.meter = { ...state.meter, provider: fact.provider, modelId: fact.modelId };
      break;

    case 'thinking':
      state.meter = { ...state.meter, effort: fact.level };
      break;

    case 'compaction':
      added.push(event(`${entry.id}:notice`, 'assistant', entry.at, [{ kind: 'notice', notice: 'compacted', detail: '' }]));
      break;

    case 'user': {
      const queued = state.inFlight;
      if (!state.inFlight) state.turnStartedAt = entry.at;
      state.inFlight = true;
      if (fact.parts.length > 0) added.push(event(entry.id, 'user', entry.at, fact.parts, { queued }));
      break;
    }

    case 'assistant': {
      const provider = fact.provider ?? state.meter.provider;
      const modelId = fact.model ?? state.meter.modelId;
      const effort = fact.thinkingLevel ?? state.meter.effort;
      state.meter = { ...state.meter, provider, modelId, effort };

      const usage = fact.usage;
      const counted = usage !== null && usage.totalTokens > 0;
      if (usage !== null && counted) {
        state.meter = {
          ...state.meter,
          lastRequestTokens: usage.totalTokens,
          lastOutputTokens: usage.output,
          totalInputTokens: state.meter.totalInputTokens + usage.input + usage.cacheWrite,
          totalOutputTokens: state.meter.totalOutputTokens + usage.output,
          totalCacheReadTokens: state.meter.totalCacheReadTokens + usage.cacheRead,
          assistantMessages: state.meter.assistantMessages + 1,
        };
      }

      const final = fact.stopReason !== 'toolUse';
      let durationMs: number | null = null;
      if (final) {
        if (state.turnStartedAt !== null && state.turnStartedAt > 0 && entry.at >= state.turnStartedAt) {
          durationMs = entry.at - state.turnStartedAt;
        }
        state.inFlight = false;
        state.turnStartedAt = null;
      } else {
        state.inFlight = true;
      }

      const notice: ConversationPart | null =
        fact.stopReason === 'aborted'
          ? { kind: 'notice', notice: 'interrupted', detail: '' }
          : fact.stopReason === 'error'
            ? { kind: 'notice', notice: 'error', detail: (fact.errorMessage ?? '').slice(0, NOTICE_DETAIL_MAX_CHARS) }
            : null;

      if (fact.parts.length > 0) {
        added.push(
          event(entry.id, 'assistant', entry.at, fact.parts, {
            model: modelKey(provider, modelId),
            usage: usage !== null && counted ? messageUsage(usage) : null,
            effort,
            // Con un aviso detras, la duracion va en el aviso: es el ultimo del turno.
            durationMs: notice === null ? durationMs : null,
          }),
        );
      }
      // Un evento con un aviso no lleva ninguna otra parte (`ConversationNoticePart`).
      if (notice !== null) added.push(event(`${entry.id}:notice`, 'assistant', entry.at, [notice], { durationMs }));
      break;
    }

    case 'toolResult':
      state.inFlight = true;
      added.push(event(entry.id, 'user', entry.at, [fact.part]));
      break;

    case 'bash': {
      // Lo corrio el usuario con `!`: va de su lado del hilo, con forma de herramienta.
      const toolUseId = `bash:${entry.id}`;
      added.push(
        event(entry.id, 'user', entry.at, [
          { kind: 'tool-call', toolUseId, name: 'bash', input: fact.command, truncated: false },
          {
            kind: 'tool-result',
            toolUseId,
            text: fact.output,
            isError: fact.failed,
            truncated: fact.truncated,
            imageCount: 0,
          },
        ]),
      );
      break;
    }
  }

  return added;
}

export interface PiTreeAddResult {
  /** true si la entrada colgaba de otro punto y hubo que rehacer la rama. */
  rebuilt: boolean;
  /** Los eventos nuevos. Vacio si `rebuilt`: ahi vale la rama entera. */
  added: ConversationEvent[];
}

export class PiSessionTree {
  /** Todas las entradas del archivo, con su padre ya resuelto. */
  private readonly nodes = new Map<string, { entry: PiEntry; parent: string | null }>();
  /** La ultima entrada del archivo: la punta de la rama activa. */
  private leafId: string | null = null;
  private state: PathState = emptyState();
  private readonly maxEvents: number;

  constructor(options: { maxEvents?: number } = {}) {
    this.maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
  }

  reset(): void {
    this.nodes.clear();
    this.leafId = null;
    this.state = emptyState();
  }

  /** Agrega una entrada, en el orden del archivo. */
  add(entry: PiEntry): PiTreeAddResult {
    const parent = entry.parentId === undefined ? this.leafId : entry.parentId;
    const linear = parent === this.leafId;
    this.nodes.set(entry.id, { entry, parent });
    this.leafId = entry.id;

    if (linear) {
      const added = step(this.state, entry);
      this.keep(added);
      return { rebuilt: false, added };
    }

    this.rebuild();
    return { rebuilt: true, added: [] };
  }

  /** Rehace el estado recorriendo el camino de la raiz a la punta. */
  private rebuild(): void {
    const chain: PiEntry[] = [];
    const seen = new Set<string>();
    let cursor = this.leafId;
    // Un padre que no esta (una linea que no se pudo leer) corta el camino ahi.
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const node = this.nodes.get(cursor);
      if (node === undefined) break;
      chain.push(node.entry);
      cursor = node.parent;
    }
    this.state = emptyState();
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const entry = chain[index];
      if (entry !== undefined) this.keep(step(this.state, entry));
    }
  }

  private keep(added: readonly ConversationEvent[]): void {
    for (const each of added) this.state.events.push(each);
    while (this.state.events.length > this.maxEvents) {
      this.state.events.shift();
      this.state.dropped += 1;
    }
  }

  /** Los eventos de la rama activa, en orden. No copiar ni modificar. */
  get events(): readonly ConversationEvent[] {
    return this.state.events;
  }

  /** Eventos viejos descartados por el tope. */
  get dropped(): number {
    return this.state.dropped;
  }

  get meter(): PiMeter {
    return this.state.meter;
  }
}
