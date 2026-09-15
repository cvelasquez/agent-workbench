/**
 * Lo ultimo que se sabe de la actividad de cada pestana.
 *
 * La actividad viaja por evento (`terminal.activity`) y un cliente que se
 * conecta despues no la recibe: una recarga dejaba sin punto a toda pestana
 * cuyo estado no cambiara mas, y peor con una CLI que no publica estado, que
 * avisa `unknown` una sola vez al lanzar. Por eso el registro anota cada aviso
 * aca y el socket reparte el libro entero al conectar.
 *
 * Desde el hito 29 (M2) un `offline` puede traer su motivo —`server-closed`:
 * el servidor de la CLI murio con la pestana enganchada— y el libro lo guarda
 * con el, para que una recarga siga mostrando la barra de relanzar.
 *
 * Puro, para que lo pruebe el chequeo sin cargar `node-pty`.
 */

import type { TerminalActivity, TerminalId, TerminalOfflineReason } from '@agent-workbench/shared';

export interface ActivityEntry {
  terminalId: TerminalId;
  activity: TerminalActivity;
  /** Solo presente con `offline` y un motivo. */
  offlineReason?: TerminalOfflineReason;
}

export class ActivityBook {
  private readonly entries = new Map<TerminalId, { activity: TerminalActivity; offlineReason: TerminalOfflineReason | null }>();

  /**
   * Anota el valor nuevo. Una pestana que ya estaba conserva su lugar. Un motivo
   * con otra actividad que `offline` no se guarda.
   */
  set(terminalId: TerminalId, activity: TerminalActivity, offlineReason: TerminalOfflineReason | null = null): void {
    this.entries.set(terminalId, { activity, offlineReason: activity === 'offline' ? offlineReason : null });
  }

  /** Lo ultimo avisado de una pestana, o null si nunca se aviso nada o ya no esta. */
  get(terminalId: TerminalId): TerminalActivity | null {
    return this.entries.get(terminalId)?.activity ?? null;
  }

  /** Por que esta `offline`, o null si no lo esta o no hay motivo. */
  offlineReasonOf(terminalId: TerminalId): TerminalOfflineReason | null {
    return this.entries.get(terminalId)?.offlineReason ?? null;
  }

  delete(terminalId: TerminalId): void {
    this.entries.delete(terminalId);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Copia, en orden de insercion. */
  snapshot(): ActivityEntry[] {
    return [...this.entries].map(([terminalId, { activity, offlineReason }]) =>
      offlineReason === null ? { terminalId, activity } : { terminalId, activity, offlineReason },
    );
  }
}

/**
 * Que hace `terminal.wake` con una pestana:
 *
 *  - `none`: ya tiene la CLI corriendo (o se esta lanzando): nada que despertar.
 *  - `spawn`: dormida o terminada, se lanza —el camino de siempre—.
 *  - `restart`: tiene proceso, pero su servidor murio sin que la app lo pidiera
 *    (`server-closed`, M2). El TUI no termina solo y no se reengancha a nada:
 *    se termina, se espera su salida y se lanza de nuevo, que relanza el
 *    servidor y vuelve a enganchar la sesion.
 */
export type WakeAction = 'none' | 'spawn' | 'restart';

export function wakeActionFor(state: {
  launching: boolean;
  alive: boolean;
  offlineReason: TerminalOfflineReason | null;
}): WakeAction {
  if (state.launching) return 'none';
  if (!state.alive) return 'spawn';
  return state.offlineReason === 'server-closed' ? 'restart' : 'none';
}
