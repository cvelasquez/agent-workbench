/**
 * El `+` que abre una pestana, partido en dos cuando hay CLIs para elegir.
 *
 * Con **una** CLI instalada es exactamente el boton de siempre: misma clase,
 * mismo titulo, y abre sin nombrar ninguna —la decide el servidor—. Nada de lo
 * que sigue se dibuja.
 *
 * Con mas de una, el `+` abre directo con la CLI que corresponde a ese sitio
 * (la del ultimo trabajo en el proyecto, o la de por defecto: la regla de
 * `Alt+T`) y dice cual en su titulo; la flecha pegada abre el menu para elegir
 * otra. La alternativa —que el `+` abra siempre el menu— le cobra un clic mas a
 * cada pestana nueva de quien trabaja con una sola CLI solo por tener otra
 * instalada (M6 del hito 25).
 */

import { useCallback, useRef, useState } from 'react';
import type { AgentId, AgentInfo } from '@agent-workbench/shared';
import { AgentMenu } from './AgentMenu.js';

interface AgentSplitButtonProps {
  /** La clase del boton de siempre (`tab-new`, `icon-button`). La llevan las dos mitades. */
  className: string;
  /** Lo que dice el boton: `+`. */
  text: string;
  /** El titulo de siempre, para cuando no hay nada que elegir. */
  title: string;
  disabled: boolean;
  offerAgentChoice: boolean;
  agents: readonly AgentInfo[];
  /** Con que CLI abre el clic directo, y cual resalta el menu. */
  agent: AgentId | null;
  /** Sin `agent`, decide el servidor: es lo que pasa con una sola CLI. */
  onOpen: (agent?: AgentId) => void;
}

export function AgentSplitButton({
  className,
  text,
  title,
  disabled,
  offerAgentChoice,
  agents,
  agent,
  onOpen,
}: AgentSplitButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const pick = useCallback(
    (chosen: AgentId) => {
      setOpen(false);
      onOpen(chosen);
    },
    [onOpen],
  );

  if (!offerAgentChoice) {
    return (
      <button className={className} onClick={() => onOpen()} disabled={disabled} title={title}>
        {text}
      </button>
    );
  }

  const label = agents.find((info) => info.id === agent)?.label ?? null;

  return (
    <span className="split-button">
      <button
        className={`${className} split-button-main`}
        onClick={() => onOpen(agent ?? undefined)}
        disabled={disabled}
        title={label === null ? title : `${title} — con ${label}`}
      >
        {text}
      </button>
      <button
        ref={arrowRef}
        className={`${className} split-button-arrow`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Elegir con qué CLI abrir"
      >
        ▾
      </button>
      {open && arrowRef.current !== null && (
        <AgentMenu
          agents={agents}
          preselected={agent}
          anchor={arrowRef.current}
          onPick={pick}
          onClose={close}
        />
      )}
    </span>
  );
}
