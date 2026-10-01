/**
 * Lo que la fila de estado del hilo necesita y no viene con la conversacion
 * (§6.30): el acuse de cada envio del cuadro, y cuando trabajo cada pestana.
 *
 * Vive en la app y no en la vista del hilo porque sigue a **todas** las
 * pestanas: mandar en una y mirar otra no puede perder el acuse, ni la hora en
 * que la primera se puso a trabajar.
 *
 * Un acuse por pestana: el ultimo envio es el unico del que la fila habla. Las
 * decisiones son funciones puras de `thread-status.ts`; aca solo se cablean.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import {
  applySubmitAck,
  nextBusyClocks,
  receiptsAfterReopen,
  type BusyClock,
  type SubmitReceipt,
} from './thread-status.js';

export interface ThreadSignals {
  /**
   * El cuadro acaba de mandar `requestId` a esa pestana. `afterEventId`: el
   * ultimo evento del hilo. `queued`: salio a la cola de la conexion, con el
   * socket caido.
   */
  track: (terminalId: TerminalId, requestId: string, afterEventId: string | null, queued: boolean) => void;
  receipts: ReadonlyMap<TerminalId, SubmitReceipt>;
  /** Cuando trabajo cada pestana (`nextBusyClock`). */
  clocks: ReadonlyMap<TerminalId, BusyClock>;
}

export function useThreadSignals(
  connection: AgentConnection,
  activity: ReadonlyMap<TerminalId, TerminalActivity>,
): ThreadSignals {
  const [receipts, setReceipts] = useState<Map<TerminalId, SubmitReceipt>>(() => new Map());
  const [clocks, setClocks] = useState<Map<TerminalId, BusyClock>>(() => new Map());

  const track = useCallback(
    (terminalId: TerminalId, requestId: string, afterEventId: string | null, queued: boolean) => {
      setReceipts((current) =>
        new Map(current).set(terminalId, {
          requestId,
          terminalId,
          afterEventId,
          phase: 'sending',
          queued,
          sentAt: Date.now(),
          deliveredAt: null,
        }),
      );
    },
    [],
  );

  useEffect(() => {
    const offMessage = connection.onMessage((message) => {
      if (message.type !== 'agent.submitted') return;
      setReceipts((current) => applySubmitAck(current, message, Date.now()));
    });
    // La cola ya salio por el socket nuevo; lo que salio por el viejo no tendra acuse.
    const offReopen = connection.onReopen(() => setReceipts((current) => receiptsAfterReopen(current, Date.now())));
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  /*
    El reloj, antes de pintar: con un efecto comun se llegaba a ver un cuadro
    con la actividad nueva y el reloj viejo. `useLayoutEffect` lo rehace antes
    de que el navegador dibuje.
  */
  const previousActivity = useRef<ReadonlyMap<TerminalId, TerminalActivity>>(new Map());
  useLayoutEffect(() => {
    const previous = previousActivity.current;
    if (previous === activity) return;
    previousActivity.current = activity;
    const now = Date.now();
    setClocks((current) => nextBusyClocks(previous, activity, current, now));
  }, [activity]);

  return { track, receipts, clocks };
}
