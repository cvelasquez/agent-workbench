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
 */

import { useEffect, useRef, useState } from 'react';
import type { TerminalDescriptor, TerminalId } from '@agent-workbench/shared';
import { projectColor } from './project-color.js';

interface TabBarProps {
  terminals: TerminalDescriptor[];
  activeTerminalId: TerminalId | null;
  canOpen: boolean;
  onSelect: (terminalId: TerminalId) => void;
  onClose: (terminalId: TerminalId) => void;
  onRename: (terminalId: TerminalId, label: string) => void;
  onReorder: (terminalIds: TerminalId[]) => void;
  onNew: () => void;
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
  canOpen,
  onSelect,
  onClose,
  onRename,
  onReorder,
  onNew,
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
                <span className={`tab-dot${terminal.alive ? '' : ' tab-dot-dead'}`} />
                <span className="tab-label">{defaultLabel(terminal)}</span>
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

      <button className="tab-new" onClick={onNew} disabled={!canOpen} title="Nueva pestana (Ctrl+T)">
        +
      </button>
    </div>
  );
}
