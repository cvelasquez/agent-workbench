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
 *
 * Los textos salen de `t()` (§6.23), al pedirlos: por eso son funciones y no
 * constantes. Los tamanos y las duraciones, de `i18n/format.ts`.
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
import { formatRoughDuration, formatWhen } from './i18n/format.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';

/** El nombre en la interfaz. En el codigo es `vault`. */
export function vaultName(): string {
  return t('vault.name');
}

/** Lo primero que dice el dialogo: que guarda y adonde puede viajar. */
export function vaultPrivacyText(): string {
  return t('vault.privacy');
}

/** Lo que no hace, dicho antes de encenderla (R3). */
export function vaultArchivedText(): string {
  return t('vault.archived');
}

export function vaultMarkText(): string {
  return t('vault.mark.copy');
}

export function vaultMarkTitle(): string {
  return t('vault.mark.copyTitle');
}

export function partialMarkText(): string {
  return t('vault.mark.partial');
}

export function partialMarkTitle(): string {
  return t('vault.mark.partialTitle');
}

/** "1 sesión" o "N sesiones". */
export function vaultSessionsText(count: number): string {
  return t('vault.sessions', { count });
}

/** true mientras el servidor esta haciendo algo que no deja empezar otra cosa. */
export function vaultBusy(state: VaultState): boolean {
  return state === 'measuring' || state === 'writing' || state === 'moving';
}

/** El estado en una palabra o dos, para la cabecera del dialogo. */
export function vaultStateText(status: Pick<VaultStatus, 'enabled' | 'state' | 'progress'>): string {
  const progress = status.progress;
  switch (status.state) {
    case 'measuring':
      return progress === null
        ? t('vault.state.measuring')
        : t('vault.state.measuringProgress', { done: progress.done, total: progress.total });
    case 'writing':
      return progress === null
        ? t('vault.state.writing')
        : t('vault.state.writingProgress', { done: progress.done, total: progress.total });
    case 'moving':
      return t('vault.state.moving');
    default:
      return status.enabled ? t('vault.state.on') : t('vault.state.off');
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
  const parts = [vaultName(), vaultSessionsText(status.sessions)];
  if (status.state === 'writing') {
    parts.push(
      status.progress === null
        ? t('vault.line.copying')
        : t('vault.line.copyingProgress', { done: status.progress.done, total: status.progress.total }),
    );
  } else if (status.state === 'moving') {
    parts.push(t('vault.line.moving'));
  } else if (status.state === 'measuring') {
    parts.push(t('vault.line.measuring'));
  } else {
    parts.push(status.lastPassAt === null ? t('vault.line.neverCopied') : formatWhen(status.lastPassAt));
  }
  if (status.pending > 0) parts.push(t('vault.line.pending', { count: status.pending }));
  return parts.join(' · ');
}

/** El titulo del boton de la cabecera. */
export function vaultButtonTitle(status: VaultStatus | null): string {
  if (status === null) return vaultName();
  return status.enabled ? t('vault.button.on') : t('vault.button.off');
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
  if (vaultBusy(status.state)) return t('vault.busy');
  if (!indexReady) return t('vault.indexNotReady');
  return null;
}

/** Por que "Cambiar carpeta…" no se puede apretar, o null si se puede. */
export function vaultChangeDirBlockedReason(status: VaultStatus): string | null {
  return vaultBusy(status.state) ? t('vault.busy') : null;
}

export function vaultPreviousDirText(previousDir: string): string {
  return t('vault.previousDir', { dir: previousDir });
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

/** Lo que una CLI no copia y por que: vacias, sin lectura entera y fallidas. */
export function vaultMeasureNote(row: VaultAgentMeasure): string | null {
  const parts: string[] = [];
  if (row.skippedEmpty > 0) parts.push(t('vault.note.empty', { count: row.skippedEmpty }));
  // La fuente no declara `wholeRead` (C7): leerla recortaria en silencio.
  if (row.unsupported > 0) parts.push(t('vault.note.unsupported', { count: row.unsupported }));
  if (row.failed > 0) {
    parts.push(
      row.failureReasons.length > 0
        ? t('vault.note.failedWithReasons', { count: row.failed, reasons: row.failureReasons.map(serverTextMessage).join('; ') })
        : t('vault.note.failed', { count: row.failed }),
    );
  }
  return parts.length === 0 ? null : t('vault.note.notCopied', { parts: parts.join(' · ') });
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
    summary:
      when.length > 0
        ? t('vault.measure.summary', { when, duration: formatRoughDuration(measurement.durationMs) })
        : t('vault.measure.summaryNoWhen', { duration: formatRoughDuration(measurement.durationMs) }),
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
      return t('vault.export.exporting');
    case 'done':
      return t('vault.export.done');
    default:
      return t('vault.export.idle');
  }
}
