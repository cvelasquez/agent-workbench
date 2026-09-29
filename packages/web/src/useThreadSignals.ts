/**
 * Lo que la fila de estado del hilo necesita y no viene con la conversacion
 * (§6.30): el acuse de cada envio del cuadro, y cuando se vio empezar a
 * trabajar a cada pestana.
 *
 * Vive en la app y no en la vista del hilo porque sigue a **todas** las
 * pestanas: mandar en una y mirar otra no puede perder el acuse, ni la hora en
 * que la primera se puso a trabajar.
 *
 * Un acuse por pestana: el ultimo envio es el unico del que la fila habla.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { SUBMIT_ACK_TIMEOUT_MS, nextBusySince, type SubmitReceipt } from './thread-status.js';

export interface ThreadSignals {
  /** El cuadro acaba de mandar `requestId` a esa pestana. `afterEventId`: el ultimo evento del hilo. */
  track: (terminalId: TerminalId, requestId: string, afterEventId: string | null) => void;
  receipts: ReadonlyMap<TerminalId, SubmitReceipt>;
  /** Cuando se vio empezar a trabajar a cada pestana (`nextBusySince`). */
  busySince: ReadonlyMap<TerminalId, number | null>;
}

/** El mapa sin los envios que todavia esperan su acuse. */
function withoutSending(current: Map<TerminalId, SubmitReceipt>): Map<TerminalId, SubmitReceipt> {
  const next = new Map([...current].filter(([, receipt]) => receipt.phase !== 'sending'));
  return next.size === current.size ? current : next;
}

export function useThreadSignals(
  connection: AgentConnection,
  activity: ReadonlyMap<TerminalId, TerminalActivity>,
): ThreadSignals {
  const [receipts, setReceipts] = useState<Map<TerminalId, SubmitReceipt>>(() => new Map());
  const [busySince, setBusySince] = useState<Map<TerminalId, number | null>>(() => new Map());
  const timers = useRef(new Map<string, number>());

  const track = useCallback((terminalId: TerminalId, requestId: string, afterEventId: string | null) => {
    setReceipts((current) =>
      new Map(current).set(terminalId, {
        requestId,
        terminalId,
        afterEventId,
        phase: 'sending',
        sentAt: Date.now(),
        deliveredAt: null,
      }),
    );
    // Un acuse que no llega no deja "Enviando…" colgado.
    const timer = window.setTimeout(() => {
      timers.current.delete(requestId);
      setReceipts((current) => {
        const receipt = current.get(terminalId);
        if (receipt?.requestId !== requestId || receipt.phase !== 'sending') return current;
        const next = new Map(current);
        next.delete(terminalId);
        return next;
      });
    }, SUBMIT_ACK_TIMEOUT_MS);
    timers.current.set(requestId, timer);
  }, []);

  useEffect(() => {
    const offMessage = connection.onMessage((message) => {
      if (message.type !== 'agent.submitted') return;
      const timer = timers.current.get(message.requestId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.current.delete(message.requestId);
      }
      setReceipts((current) => {
        const receipt = current.get(message.terminalId);
        // Solo el ultimo envio de la pestana: uno viejo que contesta tarde no pisa nada.
        if (receipt?.requestId !== message.requestId) return current;
        const next = new Map(current);
        if (message.delivered) next.set(message.terminalId, { ...receipt, phase: 'delivered', deliveredAt: Date.now() });
        else next.delete(message.terminalId);
        return next;
      });
    });
    // Al reconectar, el acuse que faltaba se perdio con el socket viejo.
    const offReopen = connection.onReopen(() => setReceipts(withoutSending));
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  // Los plazos son de esta pantalla: al desmontar no queda ninguno corriendo.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  /*
    Cuando empezo a trabajar cada una: solo un paso visto de otra cosa a
    `busy`. Una pestana que desaparece del mapa —su CLI termino— se olvida.
  */
  const previousActivity = useRef<ReadonlyMap<TerminalId, TerminalActivity>>(new Map());
  useEffect(() => {
    const previous = previousActivity.current;
    previousActivity.current = activity;
    const now = Date.now();
    setBusySince((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [terminalId, value] of activity) {
        const before = current.get(terminalId) ?? null;
        const after = nextBusySince(previous.get(terminalId), value, before, now);
        if (after !== before || !current.has(terminalId)) {
          next.set(terminalId, after);
          changed = true;
        }
      }
      for (const terminalId of current.keys()) {
        if (!activity.has(terminalId)) {
          next.delete(terminalId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activity]);

  return { track, receipts, busySince };
}
