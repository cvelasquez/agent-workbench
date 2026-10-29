/**
 * Que pestana mira esta ventana (hito 53, §5.3.2): la activa, si la ventana tiene
 * el foco y se ve. Se le dice al servidor con `terminal.attention`, y con una CLI
 * que lo declara es el foco que se le reporta: Claude Code sin foco no pide la
 * sugerencia del mensaje siguiente. Para quien desarrolla, la pestana activa es
 * como tener la CLI abierta (lo decidio el usuario).
 *
 * `attentionOf` es pura: la prueba `check-composer-input.mjs`.
 */

import { useEffect } from 'react';
import type { TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export interface AttentionView {
  activeTerminalId: TerminalId | null;
  /** La ventana tiene el foco (`document.hasFocus()`). */
  focused: boolean;
  /** La pagina se ve (`document.visibilityState`). */
  visible: boolean;
}

/** La pestana que mira la ventana, o null si ninguna. */
export function attentionOf(view: AttentionView): TerminalId | null {
  return view.focused && view.visible ? view.activeTerminalId : null;
}

/**
 * Le dice al servidor que pestana mira esta ventana: al cambiar de pestana, al
 * ganar o perder el foco, al ocultarse, y al conectar (una conexion nueva no
 * sabe nada de la anterior).
 */
export function useTabAttention(connection: AgentConnection, activeTerminalId: TerminalId | null, connected: boolean): void {
  useEffect(() => {
    if (!connected) return;
    let last: TerminalId | null | undefined;
    const report = (): void => {
      const now = attentionOf({
        activeTerminalId,
        focused: document.hasFocus(),
        visible: document.visibilityState === 'visible',
      });
      if (now === last) return;
      last = now;
      connection.send({ type: 'terminal.attention', terminalId: now });
    };
    report();
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [connection, activeTerminalId, connected]);
}
