/**
 * Barra de pestanas: reordenar arrastrando, renombrar con doble clic, cerrar.
 *
 * La etiqueta que se muestra cuando el usuario no puso ninguna sale del `cwd`,
 * porque es lo que distingue una pestana de otra de un vistazo.
 *
 * Desde el hito 18 la barra **no se desplaza**: las pestanas se encogen hasta
 * un minimo, como en Firefox. Una barra con scroll esconde pestanas, y esconder
 * es justo lo que uno no quiere cuando tiene muchas. A cambio, con la etiqueta
 * recortada hace falta otra forma de reconocerlas: cada una lleva un subrayado
 * del **color de su proyecto** (`project-color.ts`), que sale de un hash del
 * `cwd` y por lo tanto no se configura ni se guarda.
 *
 * **El punto dice que esta haciendo el agente**, no solo si el proceso vive.
 * Trabajando late, parado es un punto lleno, esperando una respuesta es un
 * signo de admiracion. El dato sale del archivo que la CLI mantiene por
 * proceso (CLAUDE.md 4.13) — no se mira la pantalla de la terminal, que es la
 * heuristica sobre texto con secuencias de escape que este proyecto ya
 * descarto dos veces.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  AgentId,
  AgentInfo,
  TerminalActivity,
  TerminalDescriptor,
  TerminalId,
} from '@agent-workbench/shared';
import { AgentBadge } from './AgentBadge.js';
import { AgentSplitButton } from './AgentSplitButton.js';
import { restingDotTitle, tabBadgeVisible } from './agent-ui.js';
import { projectColor } from './project-color.js';

interface TabBarProps {
  terminals: TerminalDescriptor[];
  activeTerminalId: TerminalId | null;
  /** Que esta haciendo la CLI de cada pestana. Sin entrada = sin proceso. */
  activity: ReadonlyMap<TerminalId, TerminalActivity>;
  canOpen: boolean;
  onSelect: (terminalId: TerminalId) => void;
  onClose: (terminalId: TerminalId) => void;
  onRename: (terminalId: TerminalId, label: string) => void;
  onReorder: (terminalIds: TerminalId[]) => void;
  /** Sin `agent` decide el servidor: con una sola CLI es lo de siempre. */
  onNew: (agent?: AgentId) => void;
  /** Las CLIs anunciadas, para el menu y el titulo de las insignias. */
  agents: readonly AgentInfo[];
  /** Mas de una instalada: insignias y boton partido. */
  offerAgentChoice: boolean;
  /** Con que CLI abre el `+` (`tabBarAgent`). Solo cuenta con `offerAgentChoice`. */
  newTabAgent: AgentId | null;
}

/**
 * El punto de estado de una pestana.
 *
 * Seis estados y ninguno es decorativo:
 *
 * | Estado | Que se ve |
 * |---|---|
 * | trabajando | tres puntitos que laten |
 * | parado | punto lleno |
 * | esperando una respuesta | `!` |
 * | dormida | punto hueco |
 * | terminada | punto apagado |
 * | la CLI no publica su estado | punto lleno, y el titulo lo dice |
 *
 * Se dibuja a codigo y no con un gif: sigue el tema claro y oscuro, se ve
 * nitido en cualquier pantalla y no mete un binario en el repositorio. Con
 * `prefers-reduced-motion` deja de latir y queda como el de "parado" — una cosa
 * que se mueve sola en la barra es exactamente lo que esa preferencia evita.
 */
function TabStatus({
  terminal,
  activity,
}: {
  terminal: TerminalDescriptor;
  activity: TerminalActivity | undefined;
}): JSX.Element {
  if (!terminal.alive) {
    const dormida = terminal.sleeping;
    return (
      <span
        className={`tab-dot${dormida ? ' tab-dot-sleeping' : ' tab-dot-dead'}`}
        title={dormida ? 'Dormida: se lee, sin CLI abierta' : 'La CLI de esta pestaña se cerró'}
      />
    );
  }

  if (activity === 'waiting') {
    return (
      <span className="tab-bang" title="La CLI está esperando una respuesta tuya">
        !
      </span>
    );
  }

  if (activity === 'busy') {
    return (
      <span className="tab-working" title="El agente está trabajando" aria-label="trabajando">
        <i />
        <i />
        <i />
      </span>
    );
  }

  // Tambien el de una CLI que no publica su estado (`unknown`): un punto liso,
  // que no afirma ni que trabaja ni que esta libre, y el titulo dice por que.
  return <span className="tab-dot" title={restingDotTitle(activity)} />;
}

function defaultLabel(terminal: TerminalDescriptor): string {
  if (terminal.label.length > 0) return terminal.label;
  const parts = terminal.cwd.split(/[\\/]/).filter((part) => part.length > 0);
  const folder = parts[parts.length - 1] ?? terminal.cwd;
  return terminal.resumed ? `${folder} ↩` : folder;
}

export function TabBar({
  terminals,
  activeTerminalId,
  activity,
  canOpen,
  onSelect,
  onClose,
  onRename,
  onReorder,
  onNew,
  agents,
  offerAgentChoice,
  newTabAgent,
}: TabBarProps): JSX.Element {
  const [editingId, setEditingId] = useState<TerminalId | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [dragId, setDragId] = useState<TerminalId | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId !== null) inputRef.current?.select();
  }, [editingId]);

  const startEditing = (terminal: TerminalDescriptor): void => {
    setEditingId(terminal.terminalId);
    setDraftLabel(terminal.label.length > 0 ? terminal.label : defaultLabel(terminal));
  };

  const commitEditing = (): void => {
    if (editingId !== null) onRename(editingId, draftLabel.trim());
    setEditingId(null);
  };

  const handleDrop = (targetId: TerminalId): void => {
    if (dragId === null || dragId === targetId) return;
    const ids = terminals.map((terminal) => terminal.terminalId);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    onReorder(ids);
    setDragId(null);
  };

  return (
    <div className="tab-bar">
      {terminals.map((terminal) => {
        const isActive = terminal.terminalId === activeTerminalId;
        const isEditing = terminal.terminalId === editingId;

        return (
          <div
            key={terminal.terminalId}
            className={`tab${isActive ? ' tab-active' : ''}${terminal.alive ? '' : ' tab-dead'}`}
            draggable={!isEditing}
            onDragStart={() => setDragId(terminal.terminalId)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => handleDrop(terminal.terminalId)}
            onDragEnd={() => setDragId(null)}
            onClick={() => onSelect(terminal.terminalId)}
            onDoubleClick={() => startEditing(terminal)}
            title={`${terminal.cwd}\n${terminal.alive ? 'activa' : `terminada (codigo ${terminal.exitCode ?? '?'})`}`}
            style={{ '--tab-project-color': projectColor(terminal.cwd) } as React.CSSProperties}
          >
            {isEditing ? (
              <input
                ref={inputRef}
                className="tab-input"
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
                onBlur={commitEditing}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitEditing();
                  if (event.key === 'Escape') setEditingId(null);
                  event.stopPropagation();
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <>
                <TabStatus terminal={terminal} activity={activity.get(terminal.terminalId)} />
                <span className="tab-label">
                  {/* Adentro de la etiqueta: se recorta con ella y no sube el minimo de 44 px. */}
                  {terminal.agent !== null && tabBadgeVisible(offerAgentChoice, terminal.agent) && (
                    <AgentBadge agent={terminal.agent} agents={agents} />
                  )}
                  {defaultLabel(terminal)}
                </span>
                <button
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(terminal.terminalId);
                  }}
                  title="Cerrar (Ctrl+W)"
                >
                  ×
                </button>
              </>
            )}
          </div>
        );
      })}

      <AgentSplitButton
        className="tab-new"
        text="+"
        title="Nueva pestana (Ctrl+T)"
        disabled={!canOpen}
        offerAgentChoice={offerAgentChoice}
        agents={agents}
        agent={newTabAgent}
        onOpen={onNew}
      />
    </div>
  );
}
