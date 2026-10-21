/**
 * Las notas que vuelven a la carpeta principal, en una línea (21-10-2026,
 * §6.38): cuántas, cuántas se juntan con lo que cambió allá, y "ver cuáles"
 * despliega la lista. Antes eran todas las rutas en un párrafo, y con catorce
 * tapaban lo que el diálogo tenía que decir. La usan quitar e integrar.
 *
 * Y las que ya juntó el agente de la rama a pedido del usuario, en otra línea:
 * no vuelven ni frenan, y así se sabe por qué.
 */

import { useState } from 'react';
import { formatList } from './i18n/format.js';
import { t } from './i18n/index.js';

interface WorktreeNotesLineProps {
  returning: readonly string[];
  merging: readonly string[];
  resolved: readonly string[];
}

export function WorktreeNotesLine({ returning, merging, resolved }: WorktreeNotesLineProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const resolvedLine =
    resolved.length > 0 ? <p className="modal-hint">{t('worktree.notes.resolved', { count: resolved.length, list: formatList(resolved) })}</p> : null;
  if (returning.length === 0) return resolvedLine;
  const merged = new Set(merging);
  return (
    <>
      {resolvedLine}
      <p className="modal-hint">
        {t('worktree.notes.back', { count: returning.length })}{' '}
        {merged.size > 0 && <>{t('worktree.notes.merged', { count: merged.size })} </>}
        <button className="link-button worktree-notes-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? t('worktree.notes.hide') : t('worktree.notes.show')}
        </button>
      </p>
      {open && (
        <ul className="worktree-notes-list">
          {returning.map((file) => (
            <li key={file}>
              {file}
              {merged.has(file) && <span className="worktree-notes-mark">{t('worktree.notes.mergedMark')}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
