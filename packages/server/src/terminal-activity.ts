/**
 * Lo ultimo que se sabe de la actividad de cada pestana.
 *
 * La actividad viaja por evento (`terminal.activity`) y un cliente que se
 * conecta despues no la recibe: una recarga dejaba sin punto a toda pestana
 * cuyo estado no cambiara mas, y peor con una CLI que no publica estado, que
 * avisa `unknown` una sola vez al lanzar. Por eso el registro anota cada aviso
 * aca y el socket reparte el libro entero al conectar.
 *
 * Puro, para que lo pruebe el chequeo sin cargar `node-pty`.
 */

import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';

export class ActivityBook {
  private readonly entries = new Map<TerminalId, TerminalActivity>();

  /** Anota el valor nuevo. Una pestana que ya estaba conserva su lugar. */
  set(terminalId: TerminalId, activity: TerminalActivity): void {
    this.entries.set(terminalId, activity);
  }

  delete(terminalId: TerminalId): void {
    this.entries.delete(terminalId);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Copia, en orden de insercion. */
  snapshot(): { terminalId: TerminalId; activity: TerminalActivity }[] {
    return [...this.entries].map(([terminalId, activity]) => ({ terminalId, activity }));
  }
}
