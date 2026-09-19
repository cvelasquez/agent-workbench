/**
 * El seguidor de una conversacion de Antigravity CLI, tal como lo usa el hub.
 *
 * Lee `brain/<id>/.system_generated/logs/transcript_full.jsonl` por offset con
 * `JsonlFollower` y el `TranscriptMapper`. La ruta sale del id, sin `cwd`. Si el
 * completo no existe y el compacto (`transcript.jsonl`) si, se sigue ese, con
 * los argumentos doble-codificados decodificados. Una vez elegido el archivo no
 * cambia, salvo que desaparezca.
 *
 * Cuatro cosas que no son evidentes:
 *
 *  - **Con `sessionId ''` no hay nada que seguir** (M4). Es la pestana nueva que
 *    todavia no descubrio su conversacion —en la 1.2.2 nace con el primer
 *    mensaje, no al lanzar—: queda `waiting`, no toca el disco y el hub la
 *    reemplaza cuando llega el id. Sin esta guarda la ruta seria
 *    `brain/.system_generated/logs/…`, que no es de nadie.
 *  - **Huella** (A6). La CLI reescribe el transcript al compactar el contexto;
 *    si no encoge, el offset no se entera. `JsonlFollower` compara los primeros
 *    256 bytes en cada lectura y reinicia si cambiaron.
 *  - **`no-transcript`**. Las conversaciones de una version anterior dejaron el
 *    transcript en 0 B y su historial en `conversations/<id>.pb`: existen, se
 *    reanudan, pero no hay nada legible. Un `.db` sin transcript, en cambio, es
 *    lo normal en los segundos que la 1.2.2 tarda en escribir el primer paso, y
 *    es `waiting`. De `conversations/` solo se hace `stat`.
 *  - **El hub relee cada `followPollMs`** (`history.ts`): en Windows un watcher
 *    no avisa lo que se le agrega a un archivo que la CLI mantiene abierto.
 *    Cada lectura mira tambien la status line (si hay), y si el uso cambio sin
 *    pasos nuevos lo dice con `usageChanged`.
 */

import { stat } from 'node:fs/promises';
import {
  EMPTY_CONTEXT_USAGE,
  normalizeCwdKey,
  type ContextUsage,
  type ConversationState,
  type PermissionMode,
} from '@agent-workbench/shared';
import type { EventPage, LoadedImage, PollResult, SessionFollower } from '../adapter.js';
import { JsonlFollower } from '../jsonl-follower.js';
import { conversationFiles, transcriptPaths, type TranscriptPaths } from './paths.js';
import { TranscriptMapper } from './transcript-mapper.js';
import type { EventLimits } from '../transport-limits.js';

/** Cuantos bytes del principio del transcript forman la huella. */
export const TRANSCRIPT_FINGERPRINT_BYTES = 256;

/**
 * Lo que el seguidor usa de la status line de Antigravity, cuando el usuario la
 * configuro. Sin ella (ausente, o `active()` false) el uso sale vacio con el
 * modelo del transcript, el modo no se observa y una llamada sin resultado
 * cuenta como abierta.
 */
export interface FollowerStatusLine {
  /** true si la status line esta configurada y activa: ahi manda ella. */
  active(): boolean;
  /**
   * true si hay un registro de la pty viva de esa conversacion. Configurada no
   * es publicando: sin registro la app no ve un menu de permiso (R27-1).
   */
  live(conversationId: string): boolean;
  /** Relee lo que haya publicado para esa conversacion. No lanza. */
  refresh(conversationId: string): Promise<void>;
  /**
   * El uso segun la status line, o null si no publico nada para esa
   * conversacion. `base` es lo que sabe el transcript (modelo y cantidad de
   * respuestas).
   */
  usage(conversationId: string, base: ContextUsage): ContextUsage | null;
  /** El modo que publico, o null. */
  permissionMode(conversationId: string): PermissionMode | null;
}

export interface AntigravityFollowerDeps {
  statusLine?: FollowerStatusLine | null;
  platform?: string;
  /** Hito 28, `FollowOptions`: los topes de cada parte. Ausente: `TRANSPORT_LIMITS`. */
  limits?: EventLimits;
  /** Hito 28, `FollowOptions`. Ausente: el tope de `JsonlFollower`. */
  maxEvents?: number;
}

const EMPTY_PAGE: EventPage = { events: [], hasMore: false };

/** true si un archivo existe y tiene contenido. Cualquier error cuenta como que no. */
async function hasBytes(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export class AntigravitySessionFollower implements SessionFollower {
  /** null con un id que no es un uuid (`''` incluido): no hay nada que seguir. */
  private readonly paths: TranscriptPaths | null;
  private readonly statusLine: FollowerStatusLine | null;
  private readonly platform: string;
  private readonly limits: EventLimits | undefined;
  private readonly maxEvents: number | undefined;
  private jsonl: JsonlFollower | null = null;
  private mapper: TranscriptMapper | null = null;
  /** true si la conversacion tiene historial en `.pb`, visto en la ultima lectura sin datos. */
  private legacyHistory = false;
  /** El uso tal como quedo en la lectura anterior; null antes de la primera. */
  private announcedUsage: string | null = null;

  constructor(
    private readonly sessionId: string,
    deps: AntigravityFollowerDeps = {},
  ) {
    this.paths = transcriptPaths(sessionId);
    this.statusLine = deps.statusLine ?? null;
    this.platform = deps.platform ?? process.platform;
    this.limits = deps.limits;
    this.maxEvents = deps.maxEvents;
  }

  get label(): string {
    if (this.jsonl?.filePath !== null && this.jsonl?.filePath !== undefined) return this.jsonl.filePath;
    if (this.paths !== null) return this.paths.full;
    return 'antigravity:(no conversation)';
  }

  /** El valor provisional sale de `defaults`: aca no hay nada que preparar. */
  async start(): Promise<void> {
    return undefined;
  }

  async poll(): Promise<PollResult> {
    const empty: PollResult = { reset: false, added: [], turns: [], plans: [], parts: [] };
    if (this.paths === null) return empty;

    await this.statusLine?.refresh(this.sessionId);

    if (this.jsonl === null) await this.choose(this.paths);
    let result: PollResult = empty;
    const jsonl = this.jsonl;
    const mapper = this.mapper;
    if (jsonl !== null && mapper !== null) {
      // Lo que haya quedado de una lectura que lanzo a mitad ya no es de nadie.
      mapper.takeParts(new Set());
      const { reset, added } = await jsonl.poll();
      const fresh = new Set(added.map((event) => event.eventId));
      result = { reset, added, turns: [], plans: [], parts: reset ? [] : mapper.takeParts(fresh) };
      if (jsonl.getState() === 'waiting') {
        // El archivo desaparecio: la proxima lectura vuelve a elegir entre los dos.
        this.jsonl = null;
        this.mapper = null;
      }
    }

    const hasData = this.jsonl !== null && this.jsonl.bytesRead > 0;
    const files = conversationFiles(this.sessionId);
    this.legacyHistory = !hasData && files !== null && (await hasBytes(files.pb));

    /*
      Contra lo que ya salio, no contra el principio de esta lectura: la status
      line puede haber cambiado entre dos lecturas. Con eventos o con reset el
      uso ya viaja (en el `append` o en el snapshot que pide el cliente).
    */
    const usage = JSON.stringify(this.getUsage());
    if (this.announcedUsage !== null && result.added.length === 0 && !result.reset && usage !== this.announcedUsage) {
      result = { ...result, usageChanged: true };
    }
    this.announcedUsage = usage;
    return result;
  }

  /** El completo si existe; si no, el compacto; si no, ninguno todavia. */
  private async choose(paths: TranscriptPaths): Promise<void> {
    let file: string | null = null;
    let compact = false;
    if (await exists(paths.full)) {
      file = paths.full;
    } else if (await exists(paths.compact)) {
      file = paths.compact;
      compact = true;
    }
    if (file === null) return;
    this.mapper = new TranscriptMapper({ compact, limits: this.limits });
    this.jsonl = new JsonlFollower(file, this.mapper, {
      fingerprintBytes: TRANSCRIPT_FINGERPRINT_BYTES,
      maxEvents: this.maxEvents,
    });
  }

  getState(): ConversationState {
    if (this.paths === null) return 'waiting';
    if (this.jsonl !== null && this.jsonl.getState() === 'live' && this.jsonl.bytesRead > 0) return 'live';
    return this.legacyHistory ? 'no-transcript' : 'waiting';
  }

  getUsage(): ContextUsage {
    const base: ContextUsage = {
      ...EMPTY_CONTEXT_USAGE,
      lastModel: this.mapper?.currentModel ?? null,
      assistantMessages: this.mapper?.assistantMessages ?? 0,
    };
    if (this.paths === null || this.statusLine === null || !this.statusLine.active()) return base;
    return this.statusLine.usage(this.sessionId, base) ?? base;
  }

  getPermissionMode(): PermissionMode | null {
    if (this.paths === null || this.statusLine === null || !this.statusLine.active()) return null;
    return this.statusLine.permissionMode(this.sessionId);
  }

  getTail(limit: number): EventPage {
    return this.jsonl?.getTail(limit) ?? EMPTY_PAGE;
  }

  getPageBefore(beforeEventId: string, limit: number): EventPage {
    return this.jsonl?.getPageBefore(beforeEventId, limit) ?? EMPTY_PAGE;
  }

  /** Esta CLI no tiene planes que la app muestre. */
  getPlanFiles(): readonly string[] {
    return [];
  }

  /** Las imagenes del usuario no se dibujan en este hito (D18). */
  async readImage(): Promise<LoadedImage | null> {
    return null;
  }

  /**
   * true si el aviso es de uno de sus dos transcripts. Sin mayusculas en
   * Windows: el watcher trae las de la carpeta en disco.
   */
  noticeChange(filePath: string): boolean {
    if (this.paths === null) return false;
    const key = normalizeCwdKey(filePath, this.platform);
    return [this.paths.full, this.paths.compact].some(
      (own) => own === filePath || normalizeCwdKey(own, this.platform) === key,
    );
  }

  /**
   * Con la status line publicando para esta pty manda ella
   * (`tool_confirmation_pending`) y esto es false. Si no, una llamada sin
   * resultado pedida desde el lanzamiento: la CLI la escribe **antes** de que
   * se conteste su permiso (medido).
   *
   * "Publicando", no "configurada" (R27-1): con la linea en `settings.json` y el
   * script fallando —`node` fuera del PATH, la CLI que la apaga tras varios
   * fallos— no llega ningun registro, y delegar ahi dejaba mandar un Enter
   * sobre un menu que la app no ve.
   */
  hasOpenToolCall(launchedAt: number): boolean {
    if (this.paths !== null && this.statusLine?.active() === true && this.statusLine.live(this.sessionId)) return false;
    return this.mapper?.hasOpenToolCall(launchedAt) ?? false;
  }
}
