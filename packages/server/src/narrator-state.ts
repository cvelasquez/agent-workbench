/**
 * El narrador (hito 57, §6.40): la unica pestana de toda la app cuyos mensajes
 * se leen en voz alta, y la ventana que los lee.
 *
 * El pedido es que no se crucen las voces. Dentro de una ventana alcanzaria con
 * un estado de la web, pero la app se abre en varias ventanas y en el telefono:
 * por eso lo guarda el servidor, y se lo dice a todas. Encenderlo en otra
 * pestana, o desde otra ventana, reemplaza al anterior.
 *
 * Vive en memoria: reiniciar el servidor lo apaga. Lo que se lee no pasa por
 * aca; la web lo saca de la conversacion que ya sigue.
 */

import type { NarratorHolder, TerminalId } from '@agent-workbench/shared';

export class NarratorState {
  private holder: NarratorHolder | null = null;

  /** Quien narra ahora, o null. */
  current(): NarratorHolder | null {
    return this.holder;
  }

  /**
   * Encenderlo (en esa pestana, para esa ventana) o apagarlo (null). Una
   * pestana que no existe no se acepta: deja el estado como estaba. Devuelve
   * true si cambio, que es cuando hay que avisarle a todas las ventanas.
   */
  set(next: NarratorHolder | null, exists: (terminalId: TerminalId) => boolean): boolean {
    if (next !== null && !exists(next.terminalId)) return false;
    const before = this.holder;
    if (before === null && next === null) return false;
    if (before !== null && next !== null && before.terminalId === next.terminalId && before.windowId === next.windowId) {
      return false;
    }
    this.holder = next === null ? null : { terminalId: next.terminalId, windowId: next.windowId };
    return true;
  }

  /** Se cerro una pestana: si era la narrada, se apaga. true si cambio. */
  dropTerminal(terminalId: TerminalId): boolean {
    if (this.holder === null || this.holder.terminalId !== terminalId) return false;
    this.holder = null;
    return true;
  }
}
