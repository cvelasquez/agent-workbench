/**
 * El icono que esconde una seccion del pie —la consola, las notas— (Hito 41,
 * §6.32). Vuelve desde Ajustes.
 *
 * **No es una ×**, a proposito: dentro de las notas la × de cada nota la borra
 * (§6.6), y dos × en la misma barra, una que borra y otra que esconde, era pedir
 * un accidente. Es un ojo tachado, como el de lo oculto en Archivos.
 *
 * Esconder la consola con terminales abiertas las cierra, y antes se pregunta:
 * una consola escondida con procesos andando es un proceso que nadie ve. La
 * pregunta sale encima del boton, porque el pie esta al borde de la pantalla.
 */

import { useState } from 'react';
import { t } from './i18n/index.js';

function HiddenEyeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

interface SectionHideButtonProps {
  title: string;
  onHide: () => void;
  /** Si esconder cierra algo, la pregunta; null si no hay nada que cerrar. */
  confirmText: string | null;
}

export function SectionHideButton({ title, onHide, confirmText }: SectionHideButtonProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);

  return (
    <span className="section-hide">
      <button
        className="icon-button"
        onClick={(event) => {
          event.stopPropagation();
          if (confirmText === null) onHide();
          else setConfirming(true);
        }}
        title={title}
        aria-label={title}
      >
        <HiddenEyeIcon />
      </button>
      {confirming && confirmText !== null && (
        <span className="section-hide-confirm" role="alert">
          <span>{confirmText}</span>
          <button
            className="link-button"
            onClick={() => {
              setConfirming(false);
              onHide();
            }}
          >
            {t('settings.panels.consoleConfirmYes')}
          </button>
          <button className="link-button" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </span>
      )}
    </span>
  );
}
