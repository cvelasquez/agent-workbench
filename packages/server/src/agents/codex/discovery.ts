/**
 * Que sesion de Codex es la de cada pestana nueva.
 *
 * Codex pone el id de sesion el mismo (un uuid v7) y no acepta que se lo den,
 * asi que una pestana nueva nace sin id y hay que descubrirlo. El archivo no
 * aparece al lanzar sino con el **primer mensaje** —medido: de 10 a 1003 s
 * despues de crearse el hilo—, y trae en la linea 0 el `cwd` y la hora de
 * creacion del hilo. Con eso se casa:
 *
 *  - **Mismo proyecto**: el `cwd` normalizado del rollout es el de la pestana.
 *  - **Lanzada antes**: el hilo se crea despues de lanzar, asi que un rollout
 *    creado en `t` es de la ultima pestana lanzada antes de `t`. Con A lanzada
 *    a las 10:00:00 y B a las 10:00:05, el hilo de A nace hacia 10:00:02 y solo
 *    A es elegible; el de B nace despues de 10:00:05 y gana B.
 *  - **Texto**: si la pestana mando algo desde el cuadro y el primer mensaje
 *    del rollout es eso, se confirma aunque la hora no alcance.
 *
 * Lo que queda dudoso se asigna igual y se avisa por consola: dos lanzamientos
 * a menos de 1,5 s, un primer mensaje que no es el que mando el cuadro, u otra
 * pestana de Codex viva en el mismo proyecto que ya sabe su sesion —casada o
 * reanudada—: un `/new` o un `/fork` ahi escribe un rollout nuevo que tambien
 * seria elegible.
 *
 * Solo se miran las carpetas de dia de `sessions/` alrededor de los
 * lanzamientos, y solo mientras haya pestanas esperando: sin pendientes no hay
 * sondeo.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeCwdKey } from '@agent-workbench/shared';
import type { LaunchHook } from '../adapter.js';
import { debugLog } from '../../debug.js';
import { parseJsonlLine, readHeadLines } from '../../jsonl-reader.js';
import { rolloutFilesIn } from './find-rollout.js';
import {
  codexSessionsRoot,
  INTERACTIVE_SOURCES,
  LISTED_HISTORY_MODES,
  localDayFolders,
  parseRolloutFileName,
  ROLLOUT_HEAD_MAX_BYTES,
  ROLLOUT_HEAD_MAX_LINES,
} from './paths.js';
import { normalizeMessageText, readSessionMeta, readUserMessageEvent } from './rollout-lines.js';

const DAY_MS = 86_400_000;
const DEFAULT_POLL_MS = 1_000;
/** Cuantos textos mandados se recuerdan por pestana. */
const MAX_SUBMITTED = 5;
/** Margen entre la hora del lanzamiento y la del hilo: relojes y redondeos. */
const LAUNCH_SLACK_MS = 1_000;
/** Dos lanzamientos mas cerca que esto no se distinguen por la hora. */
const CLOSE_LAUNCH_MS = 1_500;
/**
 * Un candidato sin pestana elegible, creado hace mas que esto, no la va a
 * tener: una pestana nueva se lanza despues de ahora, y ya no es elegible.
 */
const REJECT_AFTER_MS = 2_000;
/** Un archivo sin tocar desde bastante antes del primer lanzamiento no es de ninguna pestana. */
const OLD_FILE_SLACK_MS = 2_000;

export interface PendingTab {
  terminalId: string;
  cwd: string;
  cwdKey: string;
  launchedAt: number;
  /** `normalizeMessageText` de lo mandado desde el cuadro, los ultimos cinco. */
  submitted: string[];
  reportSessionId: (sessionId: string) => void;
}

export interface RolloutCandidate {
  path: string;
  /** `meta.id` en minusculas. */
  sessionId: string;
  cwdKey: string;
  /** `session_meta.payload.timestamp`, en epoch ms. */
  createdAt: number;
  interactive: boolean;
  /** Del primer `user_message`, o null si la cabeza no lo trae. */
  firstText: string | null;
}

export interface PickedTab {
  terminalId: string;
  confirmedByText: boolean;
  uncertain: boolean;
  reason: string | null;
}

type PendingView = Pick<PendingTab, 'terminalId' | 'cwdKey' | 'launchedAt' | 'submitted'>;
/** Una pestana de Codex viva que ya sabe su sesion. */
type LiveTab = Pick<PendingTab, 'terminalId' | 'cwdKey'>;

/** La mas nueva de la lista. */
function latest<T extends { launchedAt: number }>(tabs: readonly T[]): T {
  return tabs.reduce((best, tab) => (tab.launchedAt > best.launchedAt ? tab : best));
}

/**
 * La pestana pendiente a la que pertenece un rollout, o null. Pura.
 *
 * `married` son las otras pestanas de Codex vivas que ya tienen su sesion —las
 * que caso el descubrimiento y las que reanudaron una—: no se eligen, pero un
 * rollout nuevo en su proyecto puede ser de ellas.
 */
export function pickPendingTab(
  candidate: RolloutCandidate,
  pending: readonly PendingView[],
  married: readonly LiveTab[] = [],
): PickedTab | null {
  const eligible = pending.filter(
    (tab) => tab.cwdKey === candidate.cwdKey && tab.launchedAt - LAUNCH_SLACK_MS <= candidate.createdAt,
  );
  if (eligible.length === 0) return null;

  const text = candidate.firstText;
  const byText = text !== null && text.length > 0 ? eligible.filter((tab) => tab.submitted.includes(text)) : [];
  if (byText.length > 0) {
    const chosen = latest(byText);
    const uncertain = byText.length > 1;
    return {
      terminalId: chosen.terminalId,
      confirmedByText: true,
      uncertain,
      reason: uncertain ? 'dos pestanas mandaron el mismo texto' : null,
    };
  }

  const chosen = latest(eligible);
  let reason: string | null = null;
  if (eligible.some((tab) => tab !== chosen && Math.abs(tab.launchedAt - chosen.launchedAt) < CLOSE_LAUNCH_MS)) {
    reason = 'dos pestanas del mismo proyecto se lanzaron con menos de 1,5 s de diferencia';
  } else if (chosen.submitted.length > 0) {
    reason = 'el primer mensaje no es el que mando el cuadro de escritura';
  } else if (married.some((tab) => tab.terminalId !== chosen.terminalId && tab.cwdKey === candidate.cwdKey)) {
    reason = 'hay otra pestana de Codex abierta en el mismo proyecto';
  }
  return { terminalId: chosen.terminalId, confirmedByText: false, uncertain: reason !== null, reason };
}

export interface DiscoveryOptions {
  pollMs?: number;
  now?: () => number;
  sessionsRoot?: () => string | null;
  platform?: string;
}

/** Lo que salio de leer la cabeza de un archivo. */
type HeadReading =
  | { kind: 'rejected' }
  /** A mitad de escritura: se vuelve a mirar en la pasada siguiente. */
  | { kind: 'retry' }
  | { kind: 'candidate'; candidate: RolloutCandidate };

export class CodexSessionDiscovery {
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sessionsRoot: () => string | null;
  private readonly platform: string;
  private readonly pending = new Map<string, PendingTab>();
  /**
   * Pestanas vivas que ya saben su sesion: las que caso este descubrimiento y
   * las que se lanzaron reanudando una (`watchLive`). Despues de reiniciar el
   * servidor son casi todas de la segunda clase.
   */
  private readonly married = new Map<string, LiveTab>();
  private readonly seen = new Map<string, 'rejected' | 'assigned'>();
  private readonly assignedIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(options: DiscoveryOptions = {}) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? Date.now;
    this.sessionsRoot = options.sessionsRoot ?? codexSessionsRoot;
    this.platform = options.platform ?? process.platform;
  }

  /** Cuantas pestanas esperan su sesion. Para el chequeo. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** true si el sondeo esta andando. Para el chequeo. */
  isPolling(): boolean {
    return this.timer !== null;
  }

  register(input: {
    terminalId: string;
    cwd: string;
    launchedAt: number;
    reportSessionId: (sessionId: string) => void;
  }): LaunchHook {
    const { terminalId } = input;
    const tab: PendingTab = {
      terminalId,
      cwd: input.cwd,
      cwdKey: normalizeCwdKey(input.cwd, this.platform),
      launchedAt: input.launchedAt,
      submitted: [],
      reportSessionId: input.reportSessionId,
    };
    this.pending.set(terminalId, tab);
    this.married.delete(terminalId);
    this.startTimer();

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      // Solo si sigue siendo esta: un lanzamiento nuevo de la misma pestana ya registro otra.
      if (this.pending.get(terminalId) === tab) this.pending.delete(terminalId);
      if (this.married.get(terminalId) === tab) this.married.delete(terminalId);
      this.stopTimerIfIdle();
    };

    return {
      cancel: release,
      /*
        Una CLI que salio no va a escribir un rollout nuevo, pero pudo escribir
        uno al salir, justo despues de la ultima pasada. Se mira una vez mas y
        despues se suelta. Una pestana ya casada no tiene nada que buscar.
      */
      onExit: () => {
        if (released) return;
        if (this.pending.get(terminalId) !== tab) {
          release();
          return;
        }
        void this.finalScan().finally(release);
      },
      /*
        Escribir no suelta la espera, al reves que el contestador de Claude
        Code: la sesion aparece justamente con lo que se escribe. Se declara
        vacio porque sin el miembro el registro cancela.
      */
      onInput: () => undefined,
      onSubmitted: (text) => {
        if (released || this.pending.get(terminalId) !== tab) return;
        const normalized = normalizeMessageText(text);
        if (normalized.length === 0) return;
        tab.submitted.push(normalized);
        if (tab.submitted.length > MAX_SUBMITTED) tab.submitted.splice(0, tab.submitted.length - MAX_SUBMITTED);
      },
    };
  }

  /**
   * Anota una pestana que se lanzo reanudando una sesion: no espera nada, pero
   * mientras viva un `/new` o un `/fork` en ella escribe un rollout nuevo que
   * tambien seria elegible para una pendiente del mismo proyecto. Sin esto esa
   * asignacion salia sin aviso (M4).
   *
   * El gancho se suelta al salir el proceso, al cerrar o al relanzar, y
   * sobrevive a lo que se escribe.
   */
  watchLive(input: { terminalId: string; cwd: string }): LaunchHook {
    const { terminalId } = input;
    const tab: LiveTab = { terminalId, cwdKey: normalizeCwdKey(input.cwd, this.platform) };
    this.married.set(terminalId, tab);

    const release = (): void => {
      // Solo si sigue siendo esta: un lanzamiento nuevo de la misma pestana ya anoto otra.
      if (this.married.get(terminalId) === tab) this.married.delete(terminalId);
    };
    return { cancel: release, onExit: release, onInput: () => undefined };
  }

  /** Una pasada. No corre dos a la vez: la segunda llamada espera la que esta en curso. */
  scanOnce(): Promise<void> {
    if (this.running !== null) return this.running;
    const run = this.scan()
      .catch((error: unknown) => {
        console.warn('[codex] fallo el descubrimiento de sesiones:', error);
      })
      .finally(() => {
        this.running = null;
      });
    this.running = run;
    return run;
  }

  /** Espera la pasada en curso, si hay, y hace otra: la en curso pudo no ver lo ultimo. */
  private async finalScan(): Promise<void> {
    if (this.running !== null) await this.running;
    if (this.disposed) return;
    await this.scanOnce();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.pending.clear();
    this.married.clear();
    this.seen.clear();
    this.assignedIds.clear();
  }

  private startTimer(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setInterval(() => void this.scanOnce(), this.pollMs);
    this.timer.unref();
  }

  private stopTimerIfIdle(): void {
    if (this.pending.size > 0 || this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async scan(): Promise<void> {
    if (this.pending.size === 0) return;
    const root = this.sessionsRoot();
    if (root === null) return;

    const now = this.now();
    const minLaunch = Math.min(...[...this.pending.values()].map((tab) => tab.launchedAt));
    const candidates: RolloutCandidate[] = [];

    for (const folder of localDayFolders(root, minLaunch - DAY_MS, now + DAY_MS)) {
      for (const filePath of await rolloutFilesIn(folder)) {
        if (this.seen.has(filePath)) continue;
        let info: { mtimeMs: number; size: number };
        try {
          info = await stat(filePath);
        } catch {
          continue;
        }
        // Puede ser de antes de todo lanzamiento; mirar el stat otra vez no cuesta nada.
        if (info.mtimeMs < minLaunch - OLD_FILE_SLACK_MS) continue;

        const reading = await this.readHead(filePath, info.size);
        if (reading.kind === 'rejected') this.seen.set(filePath, 'rejected');
        else if (reading.kind === 'candidate') candidates.push(reading.candidate);
      }
    }

    candidates.sort((a, b) => a.createdAt - b.createdAt);
    for (const candidate of candidates) {
      if (this.disposed) return;
      if (this.assignedIds.has(candidate.sessionId)) {
        this.seen.set(candidate.path, 'assigned');
        continue;
      }
      const picked = pickPendingTab(candidate, [...this.pending.values()], [...this.married.values()]);
      if (picked === null) {
        if (now - candidate.createdAt > REJECT_AFTER_MS) this.seen.set(candidate.path, 'rejected');
        continue;
      }
      const tab = this.pending.get(picked.terminalId);
      if (tab === undefined) continue;

      this.seen.set(candidate.path, 'assigned');
      this.assignedIds.add(candidate.sessionId);
      this.pending.delete(tab.terminalId);
      this.married.set(tab.terminalId, tab);
      const id8 = candidate.sessionId.slice(0, 8);
      const tab8 = tab.terminalId.slice(0, 8);
      if (picked.uncertain) {
        console.warn(`[codex] la sesion ${id8} se asigno a la pestana ${tab8} sin confirmar: ${picked.reason ?? ''}`);
      }
      debugLog('registro', `sesion de codex ${id8} -> ${tab8} (${picked.confirmedByText ? 'texto' : 'lanzamiento'})`);
      tab.reportSessionId(candidate.sessionId);
    }
    this.stopTimerIfIdle();
  }

  private async readHead(filePath: string, size: number): Promise<HeadReading> {
    const name = parseRolloutFileName(path.basename(filePath));
    if (name === null) return { kind: 'rejected' };

    let lines: string[];
    try {
      lines = await readHeadLines(filePath, { maxLines: ROLLOUT_HEAD_MAX_LINES, maxBytes: ROLLOUT_HEAD_MAX_BYTES });
    } catch {
      return { kind: 'retry' };
    }
    const first = lines[0];
    // Sin linea 0 completa todavia: Codex esta escribiendo.
    if (first === undefined) return { kind: 'retry' };

    const record = parseJsonlLine(first);
    if (record === null || record['type'] !== 'session_meta') return { kind: 'rejected' };
    const meta = readSessionMeta(record['payload']);
    if (meta === null || meta.id.toLowerCase() !== name.sessionId) return { kind: 'rejected' };
    if (meta.createdAt === null) return { kind: 'rejected' };
    const interactive = typeof meta.source === 'string' && INTERACTIVE_SOURCES.includes(meta.source);
    // Un `/fork` es de la pestana donde se hizo, no de una que espera.
    if (!interactive || meta.forkedFromId !== null) return { kind: 'rejected' };
    // Lo mismo que el indice: un modo que no se lee casaria la pestana con una conversacion vacia.
    if (meta.historyMode !== null && !LISTED_HISTORY_MODES.includes(meta.historyMode)) return { kind: 'rejected' };

    let firstText: string | null = null;
    let hasUserMessage = false;
    for (const line of lines) {
      const parsed = parseJsonlLine(line);
      if (parsed?.['type'] !== 'event_msg') continue;
      // `user_message` en `legacy`; `item_completed` de un `UserMessage` en `paginated`.
      const message = readUserMessageEvent(parsed['payload']);
      if (message === null) continue;
      hasUserMessage = true;
      firstText = normalizeMessageText(message.message);
      break;
    }

    if (!hasUserMessage) {
      /*
        Si la lectura llego al final del archivo, el mensaje todavia no se
        escribio: se reintenta. Si se corto por un tope, no va a aparecer en
        la cabeza nunca —un primer mensaje enorme, o lineas de mas delante—, y
        se casa sin texto en vez de dejar la pestana esperando para siempre.
      */
      const reachedEnd = lines.length < ROLLOUT_HEAD_MAX_LINES && size <= ROLLOUT_HEAD_MAX_BYTES;
      if (reachedEnd) return { kind: 'retry' };
    }

    return {
      kind: 'candidate',
      candidate: {
        path: filePath,
        sessionId: meta.id.toLowerCase(),
        cwdKey: normalizeCwdKey(meta.cwd, this.platform),
        createdAt: meta.createdAt,
        interactive,
        firstText,
      },
    };
  }
}
