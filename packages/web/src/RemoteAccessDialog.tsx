/**
 * Diálogo del acceso remoto (hito 37, §14).
 *
 * Deja usar la app desde otro equipo de la misma red, en su navegador. **La app
 * no se abre a la red**: sigue escuchando sólo en este equipo, y el otro llega
 * por un túnel SSH. El diálogo lo dice arriba de todo, porque es lo primero que
 * uno se pregunta al ver "acceso remoto" en un servidor que lanza procesos.
 *
 * Va en el orden en que se hace:
 *
 *  1. **En este equipo, una vez**: encender el servidor SSH. La app no lo hace
 *     ni lo detecta —es un cambio del sistema que pide administrador—: remite a
 *     la guía del README.
 *  2. **En el otro equipo, cada vez**: el comando del túnel, armado para copiar.
 *  3. **Emparejar, una vez por equipo**: un código de un solo uso en una
 *     dirección. Sólo lo ve esta ventana, y se olvida cuando deja de valer.
 *
 * Encender pide reiniciar —el puerto se elige al arrancar— y el diálogo avisa
 * que eso cierra las CLIs abiertas. Apagar corta en el acto.
 *
 * Sólo se ofrece en una ventana del anfitrión: a un equipo remoto el servidor
 * no le manda este estado y le rechaza estos pedidos. `Escape` cierra sin
 * llegar a la terminal, como los demás diálogos.
 */

import { useEffect, useRef, useState } from 'react';
import type { RemoteAccessStatus, RemoteDeviceSummary, RemotePairingCode } from '@agent-workbench/shared';
import { t } from './i18n/index.js';
import {
  canPair,
  defaultHostName,
  devicePairedText,
  deviceSeenText,
  formatCountdown,
  pairingSecondsLeft,
  pairingUrl,
  parsePortInput,
  portRangeText,
  remoteStateText,
  remoteUrl,
  sshTunnelCommand,
} from './remote-access-ui.js';

/** Cuánto dura el tilde de "copiado". Como el del árbol de archivos. */
const COPIED_MS = 1_000;
/** Cuánto espera "Revocar" el segundo clic antes de volver a ser un botón común. */
const REVOKE_CONFIRM_MS = 4_000;

interface RemoteAccessDialogProps {
  status: RemoteAccessStatus;
  pairing: RemotePairingCode | null;
  problem: string | null;
  onSetEnabled: (enabled: boolean) => void;
  onSetPort: (port: number) => void;
  onStartPairing: () => void;
  onCancelPairing: () => void;
  onRenameDevice: (deviceId: string, label: string) => void;
  onRevokeDevice: (deviceId: string) => void;
  onDismissProblem: () => void;
  onClose: () => void;
}

export function RemoteAccessDialog({
  status,
  pairing,
  problem,
  onSetEnabled,
  onSetPort,
  onStartPairing,
  onCancelPairing,
  onRenameDevice,
  onRevokeDevice,
  onDismissProblem,
  onClose,
}: RemoteAccessDialogProps): JSX.Element {
  const [host, setHost] = useState(() => defaultHostName(status.hostNames));
  const [portText, setPortText] = useState(String(status.port));
  const [copied, setCopied] = useState<'command' | 'pairing' | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /*
    Cerrar el diálogo da de baja el código: uno vigente que nadie mira es una
    puerta entreabierta por cinco minutos sin motivo.
  */
  const close = (): void => {
    if (pairing !== null) onCancelPairing();
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // La cuenta regresiva del código, sólo mientras hay uno.
  useEffect(() => {
    if (pairing === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  // El puerto lo puede cambiar otra ventana: el cuadro sigue al estado.
  useEffect(() => {
    setPortText(String(status.port));
  }, [status.port]);

  // La IP cambia con el wifi: si la elegida ya no está, se vuelve al nombre.
  useEffect(() => {
    if (!status.hostNames.includes(host)) setHost(defaultHostName(status.hostNames));
  }, [status.hostNames, host]);

  const copy = (what: 'command' | 'pairing', text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(what);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
      })
      .catch(() => setCopied(null));
  };

  const parsedPort = parsePortInput(portText);
  const portChanged = parsedPort !== null && parsedPort !== status.port;
  const command = sshTunnelCommand(status, host);
  const title = t('remote.title');
  const pairUrl = pairing === null ? null : pairingUrl(status.port, pairing.code);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-button" onClick={close} title={t('common.close')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className={`status-line-state${status.state === 'active' ? ' status-line-state-active' : ''}`}>
            {remoteStateText(status.state, status.port)}
          </p>
          <p className="modal-hint">{t('remote.intro')}</p>

          <div className="vault-actions">
            {status.enabled ? (
              <>
                <button className="link-button" onClick={() => onSetEnabled(false)}>
                  {t('remote.turnOff')}
                </button>
                <span className="modal-hint">{t('remote.turnOffHint')}</span>
              </>
            ) : (
              <button className="primary-button" onClick={() => onSetEnabled(true)}>
                {t('remote.turnOn')}
              </button>
            )}
          </div>

          <div className="remote-port">
            <label className="modal-hint" htmlFor="remote-port-input">
              {t('remote.port')}
            </label>
            <input
              id="remote-port-input"
              className="remote-port-input"
              inputMode="numeric"
              value={portText}
              onChange={(event) => setPortText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && portChanged && parsedPort !== null) onSetPort(parsedPort);
              }}
            />
            <button
              className="link-button"
              onClick={() => parsedPort !== null && onSetPort(parsedPort)}
              disabled={!portChanged}
            >
              {t('remote.portSave')}
            </button>
            {parsedPort === null && <span className="modal-hint remote-port-invalid">{portRangeText()}</span>}
          </div>
          <p className="modal-hint">{t('remote.restartHint')}</p>

          {problem !== null && (
            <div className="vault-problem" role="alert">
              <span>{problem}</span>
              <button className="icon-button" onClick={onDismissProblem} title={t('common.close')}>
                ×
              </button>
            </div>
          )}

          <h3 className="modal-section">{t('remote.step.host')}</h3>
          <p className="modal-hint">{t('remote.step.hostHint')}</p>
          <p className="modal-hint">{t('remote.vpnHint')}</p>

          <h3 className="modal-section">{t('remote.step.tunnel')}</h3>
          <p className="modal-hint">{t('remote.step.tunnelHint')}</p>
          {status.hostNames.length > 1 && (
            <div className="remote-port">
              <label className="modal-hint" htmlFor="remote-host-select">
                {t('remote.address')}
              </label>
              <select
                id="remote-host-select"
                className="remote-host-select"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              >
                {status.hostNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="status-line-fragment">
            <pre className="tool-pre">{command}</pre>
            <button className="link-button" onClick={() => copy('command', command)}>
              {copied === 'command' ? <>✓ {t('remote.copied')}</> : t('remote.copy')}
            </button>
          </div>
          {status.sshUser.length > 0 && <p className="modal-hint">{t('remote.userHint', { user: status.sshUser })}</p>}

          <h3 className="modal-section">{t('remote.step.pair')}</h3>
          {pairing === null || pairUrl === null ? (
            <div className="vault-actions">
              <button className="primary-button" onClick={onStartPairing} disabled={!canPair(status)}>
                {t('remote.pair.start')}
              </button>
              {!canPair(status) && <span className="modal-hint">{t('remote.pair.needsActive')}</span>}
            </div>
          ) : (
            <>
              <p className="modal-hint">{t('remote.pair.open')}</p>
              <div className="status-line-fragment">
                <pre className="tool-pre">{pairUrl}</pre>
                <button className="link-button" onClick={() => copy('pairing', pairUrl)}>
                  {copied === 'pairing' ? <>✓ {t('remote.copied')}</> : t('remote.copy')}
                </button>
              </div>
              <p className="modal-hint">
                {t('remote.pair.expires', { time: formatCountdown(pairingSecondsLeft(pairing.expiresAt, now)) })}{' '}
                {t('remote.pair.after', { url: remoteUrl(status.port) })}
              </p>
              <div className="vault-actions">
                <button className="link-button" onClick={onCancelPairing}>
                  {t('remote.pair.cancel')}
                </button>
              </div>
            </>
          )}

          <h3 className="modal-section">{t('remote.devices')}</h3>
          {status.devices.length === 0 ? (
            <p className="modal-hint">{t('remote.devices.empty')}</p>
          ) : (
            <ul className="remote-devices">
              {status.devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  onRename={(label) => onRenameDevice(device.id, label)}
                  onRevoke={() => onRevokeDevice(device.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Un equipo emparejado. El nombre se cambia en el lugar —Enter o salir del
 * cuadro guardan; `Escape` cierra el diálogo y lo deja como estaba—, y "Revocar"
 * pide un segundo clic: deja a ese equipo afuera en el acto, y un clic de más no
 * se deshace sin volver a emparejar.
 */
function DeviceRow({
  device,
  onRename,
  onRevoke,
}: {
  device: RemoteDeviceSummary;
  onRename: (label: string) => void;
  onRevoke: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.label);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const save = (): void => {
    setEditing(false);
    const label = draft.trim();
    if (label.length > 0 && label !== device.label) onRename(label);
  };

  const revoke = (): void => {
    if (confirming) {
      onRevoke();
      return;
    }
    setConfirming(true);
    confirmTimer.current = window.setTimeout(() => setConfirming(false), REVOKE_CONFIRM_MS);
  };

  return (
    <li className="remote-device">
      <div className="remote-device-main">
        {editing ? (
          <input
            className="remote-device-input"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
        ) : (
          <button
            className="remote-device-label"
            onClick={() => {
              setDraft(device.label);
              setEditing(true);
            }}
            title={t('remote.device.rename')}
          >
            {device.label}
          </button>
        )}
        <span className={`remote-device-seen${device.connected ? ' remote-device-connected' : ''}`}>
          {deviceSeenText(device)}
        </span>
        <span className="remote-device-paired">{devicePairedText(device)}</span>
      </div>
      <button className={`link-button${confirming ? ' remote-device-confirm' : ''}`} onClick={revoke}>
        {confirming ? t('remote.device.revokeConfirm') : t('remote.device.revoke')}
      </button>
    </li>
  );
}
