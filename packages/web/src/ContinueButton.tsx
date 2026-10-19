/**
 * Continuar una conversacion con otra CLI (hito 29): `↪` en la barra, y el
 * icono de intercambio con "CLI" en el hilo.
 *
 * Un boton que abre el mismo menu que el `+` partido (`AgentMenu`), con las
 * CLIs que puede usar: las instaladas salvo la de la conversacion
 * (`continueTargets`). Quien lo monta decide si hay algo que ofrecer: con una
 * sola CLI instalada no se dibuja, y quien usa solo esa no ve nada nuevo (D21).
 *
 * Elegir no escribe nada en ninguna terminal: el servidor arma el transcript,
 * abre la pestana y decide si el mensaje se manda solo o queda en el cuadro.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { AgentId, AgentInfo } from '@agent-workbench/shared';
import { AgentMenu } from './AgentMenu.js';
import { continueButtonTitle } from './agent-ui.js';
import { t } from './i18n/index.js';

/**
 * Icono de intercambio: dos flechas en sentidos opuestos, la conversacion que
 * pasa de una CLI a otra. Sigue a `currentColor`, como los del panel Archivos.
 */
export function ContinueIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M2.5 5h11M10.5 2l3 3-3 3M13.5 11h-11M5.5 8l-3 3 3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ContinueButtonProps {
  /** Las CLIs que se ofrecen, ya filtradas. Vacia: no se dibuja nada. */
  targets: readonly AgentInfo[];
  /** La clase del boton (`icon-button …`). */
  className: string;
  /** Lo que muestra el boton. */
  text: ReactNode;
  /** El nombre para un lector de pantalla, si lo que se ve no alcanza. */
  label?: string;
  /** Por que no se puede ahora, o null. Apagado, el titulo lo dice. */
  blockedReason?: string | null;
  onPick: (target: AgentId) => void;
}

export function ContinueButton({
  targets,
  className,
  text,
  label,
  blockedReason = null,
  onPick,
}: ContinueButtonProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const pick = useCallback(
    (target: AgentId) => {
      setOpen(false);
      onPick(target);
    },
    [onPick],
  );

  if (targets.length === 0) return null;

  return (
    <>
      <button
        ref={buttonRef}
        className={className}
        onClick={() => setOpen((current) => !current)}
        disabled={blockedReason !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={blockedReason ?? continueButtonTitle()}
      >
        {text}
      </button>
      {open && buttonRef.current !== null && (
        <AgentMenu
          agents={targets}
          preselected={null}
          anchor={buttonRef.current}
          label={t('continue.menuLabel')}
          onPick={pick}
          onClose={close}
        />
      )}
    </>
  );
}
