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
import { statusLineNoFragmentText, statusLineStateText } from './agent-ui.js';
import { t } from './i18n/index.js';
import { tRich } from './i18n/rich.js';

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
  const title = t('statusLine.title', { agent: agentLabel });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-button" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className={`status-line-state${active ? ' status-line-state-active' : ''}`}>
            {statusLineStateText(info.state)}
          </p>

          <p className="modal-hint">{t('statusLine.benefit')}</p>

          <h3 className="modal-section">{t('statusLine.lineSection')}</h3>
          {info.fragment === null ? (
            <p className="modal-hint">{statusLineNoFragmentText()}</p>
          ) : (
            <>
              <p className="modal-hint">{tRich('statusLine.mergeHint')}</p>
              <div className="status-line-fragment">
                <pre className="tool-pre">{info.fragment}</pre>
                <button
                  className="link-button"
                  onClick={() => copy(info.fragment ?? '')}
                  title={t('statusLine.copyTitle')}
                >
                  {copied ? <>✓ {t('statusLine.copied')}</> : t('statusLine.copy')}
                </button>
              </div>
            </>
          )}

          <h3 className="modal-section">{t('statusLine.whereSection')}</h3>
          <p className="status-line-path">{info.settingsPath}</p>
          <p className="modal-hint">{t('statusLine.whereHint')}</p>

          <h3 className="modal-section">{t('statusLine.scriptSection')}</h3>
          <p className="modal-hint">{t('statusLine.scriptHint')}</p>
          <p className="status-line-path">{info.scriptPath}</p>
          <p className="modal-hint">{tRich('statusLine.runsEverywhere')}</p>

          <div className="status-line-actions">
            <button className="primary-button" onClick={check} disabled={checking}>
              {checking ? t('statusLine.checking') : t('statusLine.check')}
            </button>
            <span className="modal-hint">{t('statusLine.checkHint')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
