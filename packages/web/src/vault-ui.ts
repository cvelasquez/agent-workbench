/**
 * Lo que la web dice de la copia propia (hito 28): textos y decisiones puras.
 *
 * Vive aparte de los componentes por lo mismo que `agent-ui.ts`: el chequeo
 * (`check-vault.mjs`, caso 1) lo importa sin montar React, y lo que se prueba
 * ahi es exactamente lo que se dibuja.
 *
 * La regla de oro del hito pasa por aca: **con la copia apagada, la barra no
 * cambia** salvo el boton de la cabecera. `vaultLineText` da null apagada y
 * `sessionVaultView` no marca nada en una fila nativa, que son todas mientras la
 * copia no escribio ni se importo nada.
 */

import type {
  AgentInfo,
  SessionSummary,
  VaultAgentMeasure,
  VaultMeasurement,
  VaultState,
  VaultStatus,
} from '@agent-workbench/shared';
import { sessionAgentLabel } from './agent-ui.js';
import { formatWhen } from './format-when.js';

/** El nombre en la interfaz. En el codigo es `vault`. */
export const VAULT_NAME = 'Copia propia';

/** Lo primero que dice el dialogo: que guarda y adonde puede viajar. */
export const VAULT_PRIVACY_TEXT =
  'Guarda lo mismo que el historial de cada CLI —mensajes, entradas y resultados de herramientas, imágenes— en una carpeta tuya. Si la ponés en una carpeta sincronizada o en un repositorio, eso viaja con ella.';

/** Lo que no hace, dicho antes de encenderla (R3). */
export const VAULT_ARCHIVED_TEXT =
  'Las sesiones archivadas no se copian, y archivar una ya copiada no borra su copia. La app nunca borra nada de esta carpeta.';

export const VAULT_MARK_TEXT = 'copia';
export const VAULT_MARK_TITLE =
  'El historial de la CLI ya no tiene esta sesión. Se abre la copia propia, en Markdown.';
export const PARTIAL_MARK_TEXT = 'parcial';
export const PARTIAL_MARK_TITLE =
  'Sólo se rescató la ficha y los documentos: el contenido de la conversación está cifrado.';

/** "1 sesión" o "N sesiones". */
export function vaultSessionsText(count: number): string {
  return `${count} ${count === 1 ? 'sesión' : 'sesiones'}`;
}

/** Tamaño para mostrar, con la misma forma que los paneles de archivos y notas. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1_024) return `${Math.max(0, Math.round(bytes) || 0)} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(2)} GB`;
}

/** Cuanto tardo algo: "menos de 1 s", "12 s", "3 min 5 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1_000) return 'menos de 1 s';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** true mientras el servidor esta haciendo algo que no deja empezar otra cosa. */
export function vaultBusy(state: VaultState): boolean {
  return state === 'measuring' || state === 'writing' || state === 'moving';
}

function progressSuffix(status: Pick<VaultStatus, 'progress'>): string {
  return status.progress === null ? '' : ` ${status.progress.done} / ${status.progress.total}`;
}

/** El estado en una palabra o dos, para la cabecera del dialogo. */
export function vaultStateText(status: Pick<VaultStatus, 'enabled' | 'state' | 'progress'>): string {
  switch (status.state) {
    case 'measuring':
      return `Midiendo…${progressSuffix(status)}`;
    case 'writing':
      return `Copiando…${progressSuffix(status)}`;
    case 'moving':
      return 'Mudando de carpeta…';
    default:
      return status.enabled ? 'Encendida' : 'Apagada';
  }
}

/**
 * La linea de la barra, o null si no se dibuja.
 *
 * **Solo encendida** (C9): la barra ya saco sus interruptores permanentes por
 * ruido (CLAUDE.md 6), y "Copia propia apagada" en cada ventana de quien no la
 * usa seria volver a ponerlos. Apagada queda el boton de la cabecera.
 */
export function vaultLineText(status: VaultStatus | null): string | null {
  if (status === null || !status.enabled) return null;
  const parts = [VAULT_NAME, vaultSessionsText(status.sessions)];
  if (status.state === 'writing') {
    parts.push(
      status.progress === null ? 'copiando' : `copiando ${status.progress.done} / ${status.progress.total}`,
    );
  } else if (status.state === 'moving') {
    parts.push('mudando de carpeta');
  } else if (status.state === 'measuring') {
    parts.push('midiendo');
  } else {
    parts.push(status.lastPassAt === null ? 'sin copiar todavía' : formatWhen(status.lastPassAt));
  }
  if (status.pending > 0) parts.push(`${status.pending} esperando`);
  return parts.join(' · ');
}

/** El titulo del boton de la cabecera. */
export function vaultButtonTitle(status: VaultStatus | null): string {
  if (status === null) return VAULT_NAME;
  return status.enabled
    ? `${VAULT_NAME}: encendida. Ver el estado y la carpeta`
    : `${VAULT_NAME}: apagada. Configurar`;
}

/**
 * Que ofrece el dialogo para encender.
 *
 *  - `enabled`: ya esta encendida; se ofrece apagar.
 *  - `busy`: hay algo en curso; no se ofrece nada hasta que termine.
 *  - `measured`: hay medicion en este proceso del servidor (D6).
 *  - `existing`: sin medicion, pero la carpeta ya tiene sesiones que escribio
 *    una pasada. Es la regla del servidor (C18, `enableRefusal`): quien la
 *    encendio y la apago no tiene que volver a medir minutos de historial para
 *    encenderla de nuevo. Lo importado no cuenta: quien corrio un importador
 *    antes de encender nunca midio.
 *  - `needs-measure`: primero medir.
 */
export type VaultActivateOffer = 'enabled' | 'busy' | 'measured' | 'existing' | 'needs-measure';

export function vaultActivateOffer(status: VaultStatus): VaultActivateOffer {
  if (status.enabled) return 'enabled';
  if (vaultBusy(status.state)) return 'busy';
  if (status.measurement !== null) return 'measured';
  if (status.passSessions > 0) return 'existing';
  return 'needs-measure';
}

/** Por que "Medir" no se puede apretar, o null si se puede. */
export function vaultMeasureBlockedReason(status: VaultStatus, indexReady: boolean): string | null {
  if (vaultBusy(status.state)) return 'Hay una operación de la copia en curso. Esperá a que termine.';
  if (!indexReady) return 'Todavía se está leyendo el historial. Medí cuando termine.';
  return null;
}

/** Por que "Cambiar carpeta…" no se puede apretar, o null si se puede. */
export function vaultChangeDirBlockedReason(status: VaultStatus): string | null {
  return vaultBusy(status.state) ? 'Hay una operación de la copia en curso. Esperá a que termine.' : null;
}

export function vaultPreviousDirText(previousDir: string): string {
  return `La carpeta anterior quedó intacta: ${previousDir}`;
}

/** Una fila de la tabla de la medicion. */
export interface VaultMeasureRow {
  agent: VaultAgentMeasure['agent'];
  label: string;
  sessions: number;
  /** Texto e imagenes: lo que ocuparia en disco. */
  bytes: number;
  images: number;
  imageBytes: number;
  skippedArchived: number;
  /** Lo que no se copia y no es por archivada, o null si nada. */
  note: string | null;
}

export interface VaultMeasureView {
  rows: VaultMeasureRow[];
  memoryProjects: number;
  memoryBytes: number;
  total: { sessions: number; bytes: number; images: number; skippedArchived: number };
  /** "Medido hace 3 min, en 12 s". */
  summary: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Lo que una CLI no copia y por que: vacias, sin lectura entera y fallidas. */
export function vaultMeasureNote(row: VaultAgentMeasure): string | null {
  const parts: string[] = [];
  if (row.skippedEmpty > 0) parts.push(plural(row.skippedEmpty, 'vacía', 'vacías'));
  // La fuente no declara `wholeRead` (C7): leerla recortaria en silencio.
  if (row.unsupported > 0) parts.push(`${row.unsupported} sin lectura completa`);
  if (row.failed > 0) {
    const reasons = row.failureReasons.length > 0 ? ` (${row.failureReasons.join('; ')})` : '';
    parts.push(`${plural(row.failed, 'fallida', 'fallidas')}${reasons}`);
  }
  return parts.length === 0 ? null : `No se copian: ${parts.join(' · ')}`;
}

export function vaultMeasureView(measurement: VaultMeasurement, agents: readonly AgentInfo[]): VaultMeasureView {
  const rows = measurement.byAgent.map(
    (row): VaultMeasureRow => ({
      agent: row.agent,
      label: sessionAgentLabel(row.agent, agents),
      sessions: row.sessions,
      bytes: row.eventBytes + row.imageBytes,
      images: row.images,
      imageBytes: row.imageBytes,
      skippedArchived: row.skippedArchived,
      note: vaultMeasureNote(row),
    }),
  );
  const total = rows.reduce(
    (sum, row) => ({
      sessions: sum.sessions + row.sessions,
      bytes: sum.bytes + row.bytes,
      images: sum.images + row.images,
      skippedArchived: sum.skippedArchived + row.skippedArchived,
    }),
    { sessions: 0, bytes: measurement.memoryBytes, images: 0, skippedArchived: 0 },
  );
  const when = formatWhen(measurement.measuredAt);
  return {
    rows,
    memoryProjects: measurement.memoryProjects,
    memoryBytes: measurement.memoryBytes,
    total,
    summary: `Medido ${when.length > 0 ? `${when}, ` : ''}en ${formatDuration(measurement.durationMs)}`,
  };
}

/** Las marcas de una fila de la barra. Una nativa no lleva ninguna. */
export interface SessionVaultView {
  /** Solo en la copia: el clic abre el Markdown y no reanuda. */
  copy: boolean;
  partial: boolean;
}

export function sessionVaultView(session: Pick<SessionSummary, 'storage' | 'partial'>): SessionVaultView {
  const copy = session.storage === 'vault';
  return { copy, partial: copy && session.partial };
}

/** El boton "Exportar a Markdown" de un proyecto, en sus tres momentos. */
export type ExportButtonState = 'idle' | 'exporting' | 'done';

export function exportButtonTitle(state: ExportButtonState): string {
  switch (state) {
    case 'exporting':
      return 'Exportando a Markdown…';
    case 'done':
      return 'Exportado: se abrió la carpeta';
    default:
      return 'Exportar a Markdown las sesiones de este proyecto';
  }
}
