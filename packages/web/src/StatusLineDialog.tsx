/**
 * Dialogo para configurar la status line opcional de una CLI (hito 27,
 * Antigravity CLI).
 *
 * Esa CLI no deja en disco nada que diga si trabaja, si espera un permiso ni
 * cuantos tokens lleva: lo publica solo por su status line, un comando que el
 * usuario configura en su `settings.json`. La app escribe el script en su propia
 * carpeta y **muestra** la linea; no escribe ese archivo, no manda
 * `/statusline` y no ofrece un boton que lo haga. Lo edita el usuario.
 *
 * Tres cosas que el dialogo dice sin que haya que preguntar:
 *
 *  - **Que se gana**: el estado de la pestana, la barra de "esperando" y el
 *    medidor con la ventana exacta. No promete "lista para recibir": con esta
 *    CLI una pestana nueva no tiene conversacion hasta el primer mensaje, y no
 *    hay a que esperar (mandar notas sigue apagado).
 *  - **Que guarda el script**: estado, modelo y tokens, en la carpeta de la app.
 *    Nunca el email, la cuota ni el costo, que la CLI tambien le pasa.
 *  - **Que corre en toda sesion de la CLI**, tambien fuera de la app, y necesita
 *    `node` en el PATH de esa sesion.
 *
 * "Comprobar" pide que el servidor relea la configuracion; igual se entera solo
 * en un par de segundos. `Escape` cierra sin llegar a la terminal, como el
 * dialogo de atajos: si no, interrumpiria a la CLI.
 */

import { useEffect, useRef, useState } from 'react';
import type { StatusLineSetupInfo } from '@agent-workbench/shared';
import { STATUS_LINE_NO_FRAGMENT, statusLineStateText } from './agent-ui.js';

/** Cuanto dura el tilde de "copiado". Como el del arbol de archivos. */
const COPIED_MS = 1_000;
/** Si la respuesta a "Comprobar" no llega en este plazo, el boton vuelve igual. */
const CHECKING_MAX_MS = 5_000;

interface StatusLineDialogProps {
  info: StatusLineSetupInfo;
  /** El nombre de la CLI, para el titulo. */
  agentLabel: string;
  onRefresh: () => void;
  onClose: () => void;
}

export function StatusLineDialog({
  info,
  agentLabel,
  onRefresh,
  onClose,
}: StatusLineDialogProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const checkingTimer = useRef<number | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  /*
    La respuesta a "Comprobar" es una lista de CLIs nueva, y con ella un objeto
    `info` nuevo aunque diga lo mismo: es la senal de que ya se comprobo.
  */
  useEffect(() => {
    setChecking(false);
  }, [info]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      if (checkingTimer.current !== null) window.clearTimeout(checkingTimer.current);
    },
    [],
  );

  const copy = (text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch(() => setCopied(false));
  };

  const check = (): void => {
    setChecking(true);
    onRefresh();
    if (checkingTimer.current !== null) window.clearTimeout(checkingTimer.current);
    checkingTimer.current = window.setTimeout(() => setChecking(false), CHECKING_MAX_MS);
  };

  const active = info.state === 'active';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={`Status line de ${agentLabel}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">Status line de {agentLabel}</span>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className={`status-line-state${active ? ' status-line-state-active' : ''}`}>
            {statusLineStateText(info.state)}
          </p>

          <p className="modal-hint">
            Con la status line configurada, las pestañas de esta CLI muestran su estado, la barra
            de “esperando” cuando pide permiso para una herramienta, y el medidor de contexto con
            la ventana exacta. Sin ella no hay forma de saberlo: la CLI no lo deja en ningún otro
            archivo.
          </p>

          <h3 className="modal-section">La línea</h3>
          {info.fragment === null ? (
            <p className="modal-hint">{STATUS_LINE_NO_FRAGMENT}</p>
          ) : (
            <>
              <p className="modal-hint">
                Fusionala con lo que ya tiene el archivo de abajo, sin reemplazarlo: si ya tiene
                llaves, agregá solo la clave <kbd>statusLine</kbd>.
              </p>
              <div className="status-line-fragment">
                <pre className="tool-pre">{info.fragment}</pre>
                <button
                  className="link-button"
                  onClick={() => copy(info.fragment ?? '')}
                  title="Copiar la línea al portapapeles"
                >
                  {copied ? '✓ Copiada' : 'Copiar'}
                </button>
              </div>
            </>
          )}

          <h3 className="modal-section">Dónde</h3>
          <p className="status-line-path">{info.settingsPath}</p>
          <p className="modal-hint">La app no toca ese archivo: lo editás vos.</p>

          <h3 className="modal-section">Qué hace el script</h3>
          <p className="modal-hint">
            Guarda sólo estado, modelo y tokens de cada conversación, en la carpeta de la app. No
            guarda tu email, tu cuota ni el costo, que la CLI también le pasa, y no imprime nada:
            la línea propia de la CLI queda como está.
          </p>
          <p className="status-line-path">{info.scriptPath}</p>
          <p className="modal-hint">
            Con la línea puesta lo corre toda sesión de la CLI, también las que abras fuera de la
            app, y necesita <kbd>node</kbd> en el PATH.
          </p>

          <div className="status-line-actions">
            <button className="primary-button" onClick={check} disabled={checking}>
              {checking ? 'Comprobando…' : 'Comprobar'}
            </button>
            <span className="modal-hint">También se entera sola en un par de segundos.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
