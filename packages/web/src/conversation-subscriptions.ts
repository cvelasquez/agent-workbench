/**
 * Quien sigue la conversacion de cada pestana en esta ventana (hito 57, §6.40).
 *
 * Hasta el narrador, solo el hilo seguia una conversacion: la de la pestana
 * activa. El narrador sigue ademas la pestana narrada, que puede ser otra o la
 * misma. El servidor lleva **una** suscripcion por socket y pestana: un segundo
 * `conversation.subscribe` del mismo socket la rehace (manda otro `reset`), y el
 * primer `conversation.unsubscribe` la apaga para los dos. Con dos hooks
 * mandando cada uno lo suyo, cambiar de pestana activa a la narrada dejaba al
 * narrador sordo, o al hilo vacio.
 *
 * Por eso los dos pasan por aca:
 *
 *  - `subscribe` sale con el primero que la pide, y otra vez con cada uno que
 *    necesita el tramo final (`needsSnapshot`): el hilo lo dibuja con el `reset`.
 *    El narrador no lo necesita, y pedirlo con el hilo ya suscrito le borraria
 *    al hilo las paginas que el usuario cargo hacia atras.
 *  - `unsubscribe` sale con el ultimo que la suelta.
 *  - Al reconectar se vuelve a pedir una vez cada una que alguien sigue.
 */

import type { ClientMessage, TerminalId } from '@agent-workbench/shared';

/** Lo que este registro necesita de la conexion. */
export interface SubscriptionTransport {
  send(message: ClientMessage): void;
  onReopen(handler: () => void): () => void;
}

export class ConversationSubscriptions {
  private readonly counts = new Map<TerminalId, number>();

  constructor(private readonly transport: SubscriptionTransport) {
    // El servidor solo sigue una conversacion mientras hay alguien enganchado:
    // tras una reconexion no queda ninguna.
    transport.onReopen(() => {
      for (const terminalId of this.counts.keys()) {
        this.transport.send({ type: 'conversation.subscribe', terminalId });
      }
    });
  }

  /**
   * Empieza a seguir la conversacion de una pestana. Devuelve con que soltarla;
   * soltar dos veces no descuenta dos.
   */
  acquire(terminalId: TerminalId, options: { needsSnapshot: boolean }): () => void {
    const before = this.counts.get(terminalId) ?? 0;
    this.counts.set(terminalId, before + 1);
    if (before === 0 || options.needsSnapshot) {
      this.transport.send({ type: 'conversation.subscribe', terminalId });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.counts.get(terminalId) ?? 0;
      if (count <= 1) {
        this.counts.delete(terminalId);
        this.transport.send({ type: 'conversation.unsubscribe', terminalId });
      } else {
        this.counts.set(terminalId, count - 1);
      }
    };
  }

  /** Cuantos la siguen ahora. Para el chequeo. */
  holders(terminalId: TerminalId): number {
    return this.counts.get(terminalId) ?? 0;
  }
}

const registries = new WeakMap<object, ConversationSubscriptions>();

/** El registro de esta conexion: uno por conexion, compartido por el hilo y el narrador. */
export function conversationSubscriptions(connection: SubscriptionTransport): ConversationSubscriptions {
  let registry = registries.get(connection);
  if (registry === undefined) {
    registry = new ConversationSubscriptions(connection);
    registries.set(connection, registry);
  }
  return registry;
}
