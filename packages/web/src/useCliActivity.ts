/**
 * Avisa si la CLI escribio algo que todavia nadie miro.
 *
 * Existe por una consecuencia concreta de haber mandado la terminal a la
 * columna derecha: con la solapa `Cambios` delante, o con el panel escondido,
 * la CLI puede estar esperando una respuesta —un permiso, una eleccion— y no
 * hay nada en pantalla que lo diga. El punto de la solapa es ese aviso.
 *
 * Deliberadamente **no mira el contenido**. Buscar "¿esto parece un pedido de
 * permiso?" dentro de texto con secuencias de escape es una heuristica que se
 * rompe con cada cambio de la CLI y falla en silencio. "Escribio algo" es un
 * dato exacto y alcanza para lo unico que hay que decidir: si vale la pena
 * mirar.
 */

import { useEffect, useState } from 'react';
import type { TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export function useCliActivity(
  connection: AgentConnection,
  terminalId: TerminalId | null,
  /** true si la terminal esta a la vista: entonces no hay nada sin mirar. */
  watching: boolean,
): boolean {
  const [unseen, setUnseen] = useState(false);

  useEffect(() => {
    // Cambiar de pestana, o mirar la solapa, borra el aviso.
    setUnseen(false);
    if (terminalId === null || watching) return;

    return connection.onMessage((message) => {
      if (message.type === 'terminal.output' && message.terminalId === terminalId) {
        setUnseen(true);
      }
    });
  }, [connection, terminalId, watching]);

  return unseen && !watching;
}
