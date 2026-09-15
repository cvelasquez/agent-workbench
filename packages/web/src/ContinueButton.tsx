/**
 * `↪`: continuar una conversacion con otra CLI (hito 29).
 *
 * Un boton que abre el mismo menu que el `+` partido (`AgentMenu`), con las
 * CLIs que puede usar: las instaladas salvo la de la conversacion
 * (`continueTargets`). Quien lo monta decide si hay algo que ofrecer: con una
 * sola CLI instalada no se dibuja, y quien usa solo esa no ve nada nuevo (D21).
 *
 * Elegir no escribe nada en ninguna terminal: el servidor arma el transcript,
 * abre la pestana y decide si el mensaje se manda solo o queda en el cuadro.
 */

import { useCallback, useRef, useState } from 'react';
import type { AgentId, AgentInfo } from '@agent-workbench/shared';
import { AgentMenu } from './AgentMenu.js';
import { CONTINUE_BUTTON_TITLE } from './agent-ui.js';

interface ContinueButtonProps {
  /** Las CLIs que se ofrecen, ya filtradas. Vacia: no se dibuja nada. */
  targets: readonly AgentInfo[];
  /** La clase del boton (`icon-button …`). */
  className: string;
  /** Lo que dice el boton. */
  text: string;
  /** Por que no se puede ahora, o null. Apagado, el titulo lo dice. */
  blockedReason?: string | null;
  onPick: (target: AgentId) => void;
}

export function ContinueButton({
  targets,
  className,
  text,
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
        title={blockedReason ?? CONTINUE_BUTTON_TITLE}
      >
        {text}
      </button>
      {open && buttonRef.current !== null && (
        <AgentMenu
          agents={targets}
          preselected={null}
          anchor={buttonRef.current}
          label="Continuar con"
          onPick={pick}
          onClose={close}
        />
      )}
    </>
  );
}
