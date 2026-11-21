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

import type { SessionSummary, VaultState, VaultStatus } from '@agent-workbench/shared';
import { formatWhen } from './i18n/format.js';
import { t } from './i18n/index.js';

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
 *  - `off`: "Activar", sin medir antes. Hasta el 21-11-2026 pedia "Medir"
 *    primero (D6, C18); lo saco el usuario: tenia que ser un clic.
 */
export type VaultActivateOffer = 'enabled' | 'busy' | 'off';

export function vaultActivateOffer(status: VaultStatus): VaultActivateOffer {
  if (status.enabled) return 'enabled';
  if (vaultBusy(status.state)) return 'busy';
  return 'off';
}

/** Por que "Cambiar carpeta…" no se puede apretar, o null si se puede. */
export function vaultChangeDirBlockedReason(status: VaultStatus): string | null {
  return vaultBusy(status.state) ? t('vault.busy') : null;
}

export function vaultPreviousDirText(previousDir: string): string {
  return t('vault.previousDir', { dir: previousDir });
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
