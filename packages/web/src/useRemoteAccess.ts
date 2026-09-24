/**
 * El acceso remoto (hito 37, §14), del lado del navegador.
 *
 * Como la copia propia: el estado es uno solo y lo manda el servidor —al
 * conectar y en cada cambio (`remote.status`)—, y acá no se adivina nada. Lo
 * propio de esta ventana es lo que el servidor le contesta sólo a ella: el
 * código para emparejar, que no ve ninguna otra, y un pedido que falló.
 *
 * **El estado sólo llega a una ventana del anfitrión.** A una que entró como
 * equipo remoto el servidor no se lo manda, y sus pedidos los rechaza: el
 * diálogo ni se ofrece ahí.
 *
 * El código se olvida en cuanto deja de estar vigente —se usó, venció o se pidió
 * otro desde otra ventana—: lo dice `pairingActive` del estado.
 *
 * **Emparejar un teléfono** (hito 38) usa el mismo código, más una llave SSH que
 * el servidor arma en memoria y conserva mientras esta ventana no cancele: si el
 * código vence, se pide otro sin autorizar otra llave. Los dos emparejamientos
 * comparten el código, así que empezar uno borra lo que mostraba el otro.
 */

import { useCallback, useEffect, useState } from 'react';
import type { RemoteAccessStatus, RemotePairingCode, RemotePhonePairing, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { serverTextMessage } from './i18n/server-text.js';

export interface RemoteAccessApi {
  /** null hasta el primer `remote.status`: un servidor anterior al hito 37, o una ventana remota. */
  status: RemoteAccessStatus | null;
  /** El código que pidió esta ventana, mientras siga vigente. */
  pairing: RemotePairingCode | null;
  /** El emparejamiento de un teléfono que pidió esta ventana, mientras su código siga vigente. */
  phonePairing: RemotePhonePairing | null;
  /** Esta ventana pidió emparejar un teléfono y no lo canceló: el servidor guarda la llave. */
  phoneStarted: boolean;
  /** El último pedido que falló, con el texto del servidor. */
  problem: string | null;
  setEnabled: (enabled: boolean) => void;
  setPort: (port: number) => void;
  startPairing: () => void;
  cancelPairing: () => void;
  startPhonePairing: () => void;
  cancelPhonePairing: () => void;
  renameDevice: (deviceId: string, label: string) => void;
  revokeDevice: (deviceId: string) => void;
  dismissProblem: () => void;
}

export function useRemoteAccess(connection: AgentConnection): RemoteAccessApi {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairingCode | null>(null);
  const [phonePairing, setPhonePairing] = useState<RemotePhonePairing | null>(null);
  const [phoneStarted, setPhoneStarted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const offMessage = connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'remote.status':
          setStatus(message.status);
          if (!message.status.pairingActive) {
            setPairing(null);
            setPhonePairing(null);
          }
          break;

        case 'remote.pairing.code':
          setPairing(message.pairing);
          setPhonePairing(null);
          break;

        case 'remote.phone.pairing':
          setPhonePairing(message.pairing);
          setPairing(null);
          break;

        case 'error':
          if (message.code !== 'remote-failed') break;
          setProblem(serverTextMessage(message.text));
          if (message.detail !== undefined) console.error('[servidor]', message.detail);
          break;

        default:
          break;
      }
    });
    // El código era de la conexión que se cayó: el estado vuelve solo al conectar.
    const offReopen = connection.onReopen(() => {
      setPairing(null);
      // La llave era de la conexión que se cayó: el servidor ya la olvidó.
      setPhonePairing(null);
      setPhoneStarted(false);
    });
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setProblem(null);
      connection.send({ type: 'remote.configure', enabled });
    },
    [connection],
  );

  const setPort = useCallback(
    (port: number) => {
      setProblem(null);
      connection.send({ type: 'remote.configure', port });
    },
    [connection],
  );

  const startPairing = useCallback(() => {
    setProblem(null);
    connection.send({ type: 'remote.pairing.start' });
  }, [connection]);

  const cancelPairing = useCallback(() => {
    setPairing(null);
    connection.send({ type: 'remote.pairing.cancel' });
  }, [connection]);

  const startPhonePairing = useCallback(() => {
    setProblem(null);
    setPhoneStarted(true);
    connection.send({ type: 'remote.phone.start' });
  }, [connection]);

  const cancelPhonePairing = useCallback(() => {
    setPhonePairing(null);
    setPhoneStarted(false);
    connection.send({ type: 'remote.phone.cancel' });
  }, [connection]);

  const renameDevice = useCallback(
    (deviceId: string, label: string) => {
      setProblem(null);
      connection.send({ type: 'remote.device.rename', deviceId, label });
    },
    [connection],
  );

  const revokeDevice = useCallback(
    (deviceId: string) => {
      setProblem(null);
      connection.send({ type: 'remote.device.revoke', deviceId });
    },
    [connection],
  );

  const dismissProblem = useCallback(() => setProblem(null), []);

  return {
    status,
    pairing,
    phonePairing,
    phoneStarted,
    problem,
    setEnabled,
    setPort,
    startPairing,
    cancelPairing,
    startPhonePairing,
    cancelPhonePairing,
    renameDevice,
    revokeDevice,
    dismissProblem,
  };
}
