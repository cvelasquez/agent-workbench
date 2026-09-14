/**
 * Que sesion de OpenCode es la de cada pestana nueva.
 *
 * OpenCode pone el id de sesion el mismo (`ses_...`) y el TUI no acepta que se
 * lo den, asi que una pestana nueva nace sin id y hay que descubrirlo. La sesion
 * es una fila de `session` con su carpeta (`directory`) y su hora de creacion,
 * y con eso se casa:
 *
 *  - **Mismo proyecto**: la clave de la carpeta de la fila es la de la pestana.
 *    OpenCode la escribe con `/` y la pestana la tiene con `\`: se comparan
 *    normalizadas.
 *  - **Nacida despues del lanzamiento**, con un margen de relojes.
 *  - **Si dos pestanas del mismo proyecto pueden ser, decide el envio**, no la
 *    primera tecla. Lo que el navegador manda a la pty no son solo teclas:
 *    xterm contesta por ahi las consultas de capacidades del TUI y, con el
 *    reporte de foco activo, manda `ESC[I` al hacer clic. Con la primera
 *    escritura como senal, toda pestana de OpenCode "recibia entrada" a los
 *    milisegundos de lanzarse. Un envio es un texto del cuadro de escritura o
 *    de una nota, o una escritura con un Enter que no empieza con `ESC`.
 *  - **Sin envio, de nadie.** La fila nace con el primer mensaje, nunca al
 *    lanzar (medido en vivo con la 1.18.30: 464 ms despues del envio, y
 *    ninguna fila en 25 s sin escribir). Una fila que ninguna pendiente explica
 *    con un envio la abrio otro proceso en la misma carpeta, y no se asigna. Lo
 *    que queda dudoso —varias que enviaron— se asigna igual y se avisa por
 *    consola.
 *
 * Si una version futura creara la fila al lanzar, ninguna pestana nueva se
 * casaria: se veria como una pestana que sigue "esperando el primer mensaje"
 * con su sesion ya en la barra, y hay que volver a medir.
 *
 * Solo se mira mientras haya pestanas esperando: el descubrimiento se suscribe
 * al aviso de cambios de la base con la primera y se va con la ultima. Una vez
 * casada, la pestana no sigue mirando: un `<leader>n` dentro del TUI abre otra
 * sesion y la pestana queda atada a la primera.
 */

import { normalizeCwdKey } from '@agent-workbench/shared';
import type { LaunchHook, SpawnedContext } from '../adapter.js';
import { debugLog } from '../../debug.js';
import { OPENCODE_SQL, type DiscoveryRow } from './sql.js';

/**
 * Margen entre la hora del lanzamiento y la de la fila, para no descartar una
 * sesion por redondeos. No se aplica al envio: ver `sentBefore`.
 */
export const DISCOVERY_SKEW_MS = 2_000;

export interface PendingTab {
  terminalId: string;
  /** `normalizeCwdKey` del `cwd` de la pty. */
  cwdKey: string;
  launchedAt: number;
  /** Epoch ms del primer envio desde el lanzamiento, o null si todavia ninguno. */
  submittedAt: number | null;
}

export interface Assignment {
  terminalId: string;
  sessionId: string;
  uncertain: boolean;
  /** Por que quedo dudosa, o null si no. */
  reason: string | null;
}

const newest = <T>(tabs: readonly T[], key: (tab: T) => number): T =>
  tabs.reduce((best, tab) => (key(tab) > key(best) ? tab : best));

/**
 * true si la pestana envio algo antes de que naciera la fila: ese envio pudo
 * crearla.
 *
 * **Sin margen.** El envio se anota antes de la primera escritura en la pty
 * (`noteSubmitted`, y el gancho antes de `write`), y OpenCode crea la fila
 * despues de procesarlo, con el mismo reloj del sistema: medido, 464 ms
 * despues. Un margen solo servia para equivocarse: una sesion ajena nacida
 * poco antes del envio pasaba a ser de la pestana, y por ir primero en el
 * orden le ganaba a la suya.
 */
const sentBefore = (tab: PendingTab, row: DiscoveryRow): boolean =>
  tab.submittedAt !== null && tab.submittedAt <= row.time_created;

/**
 * Que pestana pendiente es la de cada fila. Pura: la prueba el chequeo.
 *
 * Las filas se recorren en `(time_created, id)` y cada pestana se asigna una
 * sola vez. `claimed` son los ids que este proceso ya asigno.
 *
 * Entre las candidatas cuentan solo las que enviaron algo antes de que naciera
 * la fila:
 *
 *  1. Ninguna: la fila es de otro proceso y no se asigna.
 *  2. Una: gana sin duda.
 *  3. Varias: la del envio mas reciente. Dudosa.
 */
export function matchDiscoveries(
  rows: readonly DiscoveryRow[],
  pending: readonly PendingTab[],
  claimed: ReadonlySet<string>,
  platform: string,
): Assignment[] {
  const ordered = [...rows].sort((a, b) =>
    a.time_created !== b.time_created ? a.time_created - b.time_created : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const assignments: Assignment[] = [];
  const takenTabs = new Set<string>();
  const takenIds = new Set<string>();

  for (const row of ordered) {
    if (claimed.has(row.id) || takenIds.has(row.id)) continue;
    const key = normalizeCwdKey(row.directory, platform);
    if (key.length === 0) continue;
    const candidates = pending.filter(
      (tab) =>
        !takenTabs.has(tab.terminalId) &&
        tab.cwdKey === key &&
        row.time_created >= tab.launchedAt - DISCOVERY_SKEW_MS,
    );
    /*
      Medido en vivo con la 1.18.30 (paso 9): la fila nace con el primer
      mensaje —464 ms despues del envio, y ninguna en 25 s sin escribir—, nunca
      al lanzar. Una fila que ninguna candidata explica con un envio la creo
      otro proceso en la misma carpeta —OpenCode Desktop, `opencode` en otra
      terminal— y no es de nadie aca: asignarla dejaba la pestana casada con
      una conversacion ajena y, como una casada deja de mirar, sin descubrir
      la suya (R26-3).
    */
    const sent = candidates.filter((tab) => sentBefore(tab, row));
    if (sent.length === 0) continue;

    let chosen: PendingTab;
    let reason: string | null = null;
    if (sent.length === 1) {
      chosen = sent[0] as PendingTab;
    } else {
      chosen = newest(sent, (tab) => tab.submittedAt ?? 0);
      reason = 'varias pestanas del mismo proyecto enviaron algo antes de que naciera la sesion';
    }

    takenTabs.add(chosen.terminalId);
    takenIds.add(row.id);
    assignments.push({ terminalId: chosen.terminalId, sessionId: row.id, uncertain: reason !== null, reason });
  }
  return assignments;
}

/**
 * true si lo escrito en la pty cuenta como un envio: trae un Enter y no empieza
 * con `ESC`. Deja afuera las respuestas de la terminal a las consultas del TUI,
 * el reporte de foco, las flechas y un pegado entre marcadores, que empiezan
 * todos con `ESC`.
 */
export function isTypedSubmission(data: string): boolean {
  return data.includes('\r') && !data.startsWith('\x1b');
}

/** Lo que el descubrimiento usa de la base: solo `discoveryRows`. */
export interface DiscoveryDatabase {
  all<T>(sql: string, ...params: number[]): T[];
}

export interface DiscoverySignal {
  subscribe(listener: () => void): () => void;
}

export interface DiscoveryOptions {
  db: DiscoveryDatabase;
  /** El aviso de cambios de la base: el mismo sondeo que usa el watcher. */
  signal: DiscoverySignal;
  platform?: string;
  now?: () => number;
  warn?: (message: string) => void;
}

type TrackedContext = Pick<SpawnedContext, 'terminalId' | 'cwd' | 'launchedAt' | 'reportSessionId'>;

interface Tracked extends PendingTab {
  reportSessionId: (sessionId: string) => void;
}

export class OpenCodeSessionDiscovery {
  private readonly db: DiscoveryDatabase;
  private readonly signal: DiscoverySignal;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly pending = new Map<string, Tracked>();
  /** Ids que este proceso ya asigno: una fila no se casa dos veces. */
  private readonly claimed = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(options: DiscoveryOptions) {
    this.db = options.db;
    this.signal = options.signal;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /** Cuantas pestanas esperan su sesion. Para el chequeo. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** true si esta suscrito al aviso de la base. Para el chequeo. */
  isListening(): boolean {
    return this.unsubscribe !== null;
  }

  /**
   * Anota una pestana nueva que espera su sesion y mira enseguida.
   *
   * El gancho sobrevive a lo que se escribe —la sesion aparece justamente con
   * eso— y lo usa para anotar el envio. Se suelta al cerrar, al apagar o al
   * relanzar; al salir el proceso mira una vez mas, porque la fila pudo nacer
   * justo antes y el aviso de la base llegar despues.
   */
  track(context: TrackedContext): LaunchHook {
    const { terminalId } = context;
    const tab: Tracked = {
      terminalId,
      cwdKey: normalizeCwdKey(context.cwd, this.platform),
      launchedAt: context.launchedAt,
      submittedAt: null,
      reportSessionId: (sessionId) => context.reportSessionId(sessionId),
    };
    this.pending.set(terminalId, tab);
    this.listen();
    /*
      Enseguida, pero no adentro de `onSpawned`: el registro todavia no termino
      de lanzar, y un id avisado ahi lo pisaria el aviso de sesion vacia que
      manda despues.
    */
    setImmediate(() => this.attempt());

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      // Solo si sigue siendo esta: un lanzamiento nuevo de la misma pestana ya anoto otra.
      if (this.pending.get(terminalId) === tab) this.pending.delete(terminalId);
      this.stopIfIdle();
    };
    const noteSubmission = (): void => {
      if (released || this.pending.get(terminalId) !== tab || tab.submittedAt !== null) return;
      tab.submittedAt = this.now();
    };

    return {
      cancel: release,
      onExit: () => {
        if (!released && this.pending.get(terminalId) === tab) this.attempt();
        release();
      },
      onInput: (data) => {
        if (isTypedSubmission(data)) noteSubmission();
      },
      onSubmitted: () => noteSubmission(),
    };
  }

  /**
   * Un intento: las raices nacidas desde el primer lanzamiento pendiente, y a
   * cada pestana la suya. Publico para el chequeo.
   */
  attempt(): void {
    if (this.disposed || this.pending.size === 0) return;
    const since = Math.min(...[...this.pending.values()].map((tab) => tab.launchedAt)) - DISCOVERY_SKEW_MS;
    let rows: DiscoveryRow[];
    try {
      rows = this.db.all<DiscoveryRow>(OPENCODE_SQL.discoveryRows, since);
    } catch (error) {
      // Una base ocupada un instante: el proximo aviso vuelve a intentar.
      debugLog('registro', `opencode: no se pudo mirar si nacio una sesion: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const assignment of matchDiscoveries(rows, [...this.pending.values()], this.claimed, this.platform)) {
      const tab = this.pending.get(assignment.terminalId);
      if (tab === undefined) continue;
      this.claimed.add(assignment.sessionId);
      this.pending.delete(tab.terminalId);
      const tab8 = tab.terminalId.slice(0, 8);
      if (assignment.uncertain) {
        this.warn(
          `[opencode] la sesion ${assignment.sessionId} se asigno a la pestana ${tab8} sin confirmar: ${assignment.reason ?? ''}. Si quedo cruzada, cerra la pestana y reanuda la sesion desde la barra.`,
        );
      }
      debugLog('registro', `sesion de opencode ${assignment.sessionId} -> ${tab8}`);
      tab.reportSessionId(assignment.sessionId);
    }
    this.stopIfIdle();
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.claimed.clear();
    this.stop();
  }

  private listen(): void {
    if (this.unsubscribe !== null || this.disposed) return;
    this.unsubscribe = this.signal.subscribe(() => this.attempt());
  }

  private stopIfIdle(): void {
    if (this.pending.size === 0) this.stop();
  }

  private stop(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    unsubscribe?.();
  }
}
