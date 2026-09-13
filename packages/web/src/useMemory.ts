/**
 * La memoria compartida del proyecto de la pestana activa.
 *
 * Se suscribe con el panel abierto, aunque la solapa "Memoria" no este
 * delante: de ahi sale la pastilla con la cantidad de notas, y un numero que
 * solo aparece mirando la lista no avisa de nada. Es la misma excepcion que git
 * (App.tsx). El watcher del servidor es barato: mira un puñado de nombres.
 *
 * Es el unico panel que **escribe** dentro del proyecto, y por eso el flujo
 * tiene dos pasos que se ven aca: `requestPlan` pide lo que cambiaria sin tocar
 * nada, e `install` lo aplica **con las mismas opciones con las que se pidio la
 * previsualizacion**, que se guardan aca y no en la vista: si la vista se
 * desmonta —se cambio de solapa— y vuelve, lo que se instala sigue siendo lo
 * que se vio. Lo que viaja son las opciones, nunca los cambios ni una ruta: el
 * servidor rehace el plan al instalar.
 *
 * **Cada pedido lleva un `requestId`, y solo se atiende la respuesta que
 * corresponde a un pedido vivo.** Los errores del servidor no dicen de que
 * pestana son: sin esto, el fallo de una instalacion en el proyecto que se
 * dejo atras aparecia en el panel del que se esta mirando, y el error de otro
 * panel apagaba el "Escribiendo…" de una instalacion en curso. Por lo mismo,
 * volver a la lista con "← Memoria" abandona la lectura: si el contenido llega
 * tarde, no reabre la nota.
 *
 * La suscripcion se rehace al reconectar, por lo mismo que git: tras un `F5` el
 * servidor ya no tiene a nadie enganchado y el panel se quedaria congelado. Y
 * lo que estaba en camino por el socket que se cayo no va a tener respuesta:
 * se da por perdido en vez de dejar el panel trabado en "Escribiendo…".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MemoryChange,
  MemoryInstallOptions,
  MemoryNoteContent,
  MemoryStatus,
  TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export type MemoryBusy = 'plan' | 'install' | 'import' | null;

type RequestKind = 'subscribe' | 'plan' | 'install' | 'import' | 'read';

/**
 * Los `requestId` que emitio este panel, de toda la app.
 *
 * Vive en el modulo y no en el hook porque lo consulta tambien `useWorkspace`:
 * un error que responde a un pedido de la memoria lo muestra el panel, y el
 * aviso general no lo repite. Al cambiar de pestana los ids salen de aca, asi
 * que el error de un pedido que quedo huerfano vuelve al aviso general, que es
 * donde corresponde: el panel ya muestra otro proyecto.
 */
const claimedRequests = new Set<string>();

/** true si el error responde a un pedido del panel de memoria, que lo muestra el. */
export function isMemoryPanelRequest(requestId: string | undefined): boolean {
  return requestId !== undefined && claimedRequests.has(requestId);
}

export interface MemoryView {
  /** Estado de la memoria, o null mientras no llego el primero. */
  status: MemoryStatus | null;
  /** La nota abierta, o null si se esta viendo la lista. */
  open: MemoryNoteContent | null;
  /** Nombre de la nota que se pidio y todavia no llego. */
  loading: string | null;
  /** Cambios de la ultima previsualizacion, o null si no hay ninguna abierta. */
  planned: MemoryChange[] | null;
  busy: MemoryBusy;
  /** Resultado de la ultima instalacion o importacion, en una frase. */
  lastResult: string | null;
  error: string | null;
  openNote: (name: string) => void;
  closeNote: () => void;
  requestPlan: (options: MemoryInstallOptions) => void;
  /** Instala con las opciones de la previsualizacion abierta. Sin ella, no hace nada. */
  install: () => void;
  importNative: () => void;
  cancelPlan: () => void;
  dismissMessage: () => void;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function installedText(applied: MemoryChange[]): string {
  if (applied.length === 0) return 'No había nada que cambiar: el puente ya estaba al día.';
  return `Listo: ${plural(applied.length, 'archivo cambiado', 'archivos cambiados')}.`;
}

function importedText(copied: string[], skipped: string[]): string {
  const head =
    copied.length === 0
      ? 'No había notas nuevas para importar.'
      : `Importadas ${plural(copied.length, 'nota', 'notas')}.`;
  if (skipped.length === 0) return head;
  return `${head} No se pisaron, porque ya existían con otro contenido: ${skipped.join(', ')}.`;
}

export function useMemory(connection: AgentConnection, terminalId: TerminalId | null): MemoryView {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [open, setOpen] = useState<MemoryNoteContent | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [planned, setPlanned] = useState<MemoryChange[] | null>(null);
  const [busy, setBusy] = useState<MemoryBusy>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Pedidos en camino, por `requestId`. Lo que no esta aca no se atiende. */
  const pending = useRef(new Map<string, RequestKind>());
  /** Todos los ids emitidos con esta pestana, para soltarlos de `claimedRequests`. */
  const issued = useRef(new Set<string>());
  /** Las opciones con las que se pidio la previsualizacion abierta. */
  const plannedOptions = useRef<MemoryInstallOptions | null>(null);
  /**
   * El error en pantalla vino de la suscripcion. El primer estado que llegue
   * lo da por resuelto: si `.agents` apuntaba afuera y se corrigio, el watcher
   * manda el estado nuevo y el aviso rojo no puede quedarse arriba.
   */
  const errorFromSubscribe = useRef(false);

  const issue = useCallback((kind: RequestKind): string => {
    const requestId = `memory-${crypto.randomUUID()}`;
    pending.current.set(requestId, kind);
    issued.current.add(requestId);
    claimedRequests.add(requestId);
    return requestId;
  }, []);

  /** Abandona los pedidos de una clase: si su respuesta llega, se ignora. */
  const abandon = useCallback((kind: RequestKind): void => {
    for (const [requestId, pendingKind] of pending.current) {
      if (pendingKind === kind) pending.current.delete(requestId);
    }
  }, []);

  useEffect(() => {
    // Todo limpio al cambiar de pestana: la memoria de otro proyecto un
    // instante es peor que un panel vacio, y una previsualizacion vieja
    // instalaria en el proyecto equivocado.
    setStatus(null);
    setOpen(null);
    setLoading(null);
    setPlanned(null);
    setBusy(null);
    setLastResult(null);
    setError(null);
    pending.current.clear();
    for (const requestId of issued.current) claimedRequests.delete(requestId);
    issued.current.clear();
    plannedOptions.current = null;
    errorFromSubscribe.current = false;
    if (terminalId === null) return;

    // `take` consume el pedido: una respuesta repetida o ajena no pasa dos veces.
    const take = (requestId: string | undefined, kind: RequestKind): boolean => {
      if (requestId === undefined || pending.current.get(requestId) !== kind) return false;
      pending.current.delete(requestId);
      return true;
    };

    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'memory.status':
          if (message.terminalId !== terminalId) break;
          setStatus(message.status);
          if (errorFromSubscribe.current) {
            errorFromSubscribe.current = false;
            setError(null);
          }
          break;
        case 'memory.planned':
          if (message.terminalId !== terminalId || !take(message.requestId, 'plan')) break;
          setPlanned(message.changes);
          setBusy(null);
          break;
        case 'memory.installed':
          if (message.terminalId !== terminalId || !take(message.requestId, 'install')) break;
          plannedOptions.current = null;
          setPlanned(null);
          setBusy(null);
          setLastResult(installedText(message.applied));
          break;
        case 'memory.imported':
          if (message.terminalId !== terminalId || !take(message.requestId, 'import')) break;
          setBusy(null);
          setLastResult(importedText(message.copied, message.skipped));
          break;
        case 'memory.content':
          if (message.terminalId !== terminalId || !take(message.requestId, 'read')) break;
          setOpen(message.note);
          setLoading(null);
          break;
        case 'error': {
          // Solo los errores de un pedido propio y vivo. El de otro panel, o el
          // de un pedido de la pestana que se dejo atras, no es de aca.
          const requestId = message.requestId;
          const kind = requestId === undefined ? undefined : pending.current.get(requestId);
          if (requestId === undefined || kind === undefined) break;
          pending.current.delete(requestId);
          if (kind === 'read') setLoading(null);
          else if (kind !== 'subscribe') setBusy(null);
          setError(message.message);
          errorFromSubscribe.current = kind === 'subscribe';
          break;
        }
        default:
          break;
      }
    });

    const offStatus = connection.onStatus((next) => {
      if (next !== 'reconnecting' && next !== 'failed') return;
      // El servidor contesta por el socket que llego el pedido; si ese socket
      // se cayo, la respuesta no llega nunca. Lo que se pida mientras tanto
      // queda en la cola de la conexion y si tiene respuesta.
      const lost = new Set(pending.current.values());
      pending.current.clear();
      setBusy(null);
      setLoading(null);
      if (lost.has('install') || lost.has('import')) {
        plannedOptions.current = null;
        setPlanned(null);
        setError(
          'Se cortó la conexión antes de la respuesta. Al reconectar, el estado dice qué quedó escrito.',
        );
      }
    });

    // La primera lectura es un pedido como los demas: si `.agents` apunta fuera
    // del proyecto llega un `invalid-path`, y es este panel el que tiene que
    // decirlo.
    const subscribe = (): void => {
      connection.send({ type: 'memory.subscribe', terminalId, requestId: issue('subscribe') });
    };
    subscribe();
    const offReopen = connection.onReopen(subscribe);

    return () => {
      offMessage();
      offStatus();
      offReopen();
      connection.send({ type: 'memory.unsubscribe', terminalId });
    };
  }, [connection, terminalId, issue]);

  // Lo que se muestra de la accion anterior se borra al empezar otra: un
  // "Listo" viejo al lado de un pedido nuevo confunde sobre cual termino.
  const start = useCallback((): void => {
    errorFromSubscribe.current = false;
    setError(null);
    setLastResult(null);
  }, []);

  const openNote = useCallback(
    (name: string) => {
      if (terminalId === null) return;
      abandon('read');
      start();
      setLoading(name);
      setOpen(null);
      connection.send({ type: 'memory.read', terminalId, name, requestId: issue('read') });
    },
    [connection, terminalId, start, abandon, issue],
  );

  const closeNote = useCallback(() => {
    abandon('read');
    setOpen(null);
    setLoading(null);
  }, [abandon]);

  const requestPlan = useCallback(
    (options: MemoryInstallOptions) => {
      if (terminalId === null) return;
      start();
      plannedOptions.current = options;
      setPlanned(null);
      setBusy('plan');
      connection.send({ type: 'memory.plan', terminalId, options, requestId: issue('plan') });
    },
    [connection, terminalId, start, issue],
  );

  const install = useCallback(() => {
    const options = plannedOptions.current;
    if (terminalId === null || options === null) return;
    start();
    setBusy('install');
    connection.send({ type: 'memory.install', terminalId, options, requestId: issue('install') });
  }, [connection, terminalId, start, issue]);

  const importNative = useCallback(() => {
    if (terminalId === null) return;
    start();
    setBusy('import');
    connection.send({ type: 'memory.import', terminalId, requestId: issue('import') });
  }, [connection, terminalId, start, issue]);

  const cancelPlan = useCallback(() => {
    abandon('plan');
    plannedOptions.current = null;
    setPlanned(null);
  }, [abandon]);

  const dismissMessage = useCallback(() => {
    errorFromSubscribe.current = false;
    setError(null);
    setLastResult(null);
  }, []);

  return {
    status,
    open,
    loading,
    planned,
    busy,
    lastResult,
    error,
    openNote,
    closeNote,
    requestPlan,
    install,
    importNative,
    cancelPlan,
    dismissMessage,
  };
}
