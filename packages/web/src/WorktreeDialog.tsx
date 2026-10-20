/**
 * "Nueva sesión en una rama aparte" (hito 48, §6.38).
 *
 * Pide el nombre de la rama (validado mientras se escribe, con las mismas
 * reglas que el servidor), de qué rama sale o qué rama que ya existe se abre, y
 * con qué CLI. Antes de crear nada muestra **la carpeta y el comando de git**,
 * como pide §6.1 para todo lo que cambia el repo, qué notas ignoradas se copian
 * y si la carpeta principal tiene cambios sin commit, que la rama nueva no se
 * lleva.
 *
 * `Escape` cierra sin llegar a la terminal, como los demás diálogos.
 */

import { useEffect, useMemo, useState } from 'react';
import type { AgentId, AgentInfo, WorktreeCreateMode } from '@agent-workbench/shared';
import { formatList } from './i18n/format.js';
import { t } from './i18n/index.js';
import type { CreateDialog, WorktreeCreateChoice } from './useWorktrees.js';
import { copySummaryText, createBlocker, createCommandPreview, folderPreview } from './worktree-ui.js';

interface WorktreeDialogProps {
  dialog: CreateDialog;
  /** Las CLIs instaladas, para elegir con cuál se abre. */
  agents: readonly AgentInfo[];
  offerAgentChoice: boolean;
  /** La que viene elegida: la del proyecto, o la de por defecto. */
  agent: AgentId | null;
  onSubmit: (choice: WorktreeCreateChoice) => void;
  onClose: () => void;
}

export function WorktreeDialog({ dialog, agents, offerAgentChoice, agent, onSubmit, onClose }: WorktreeDialogProps): JSX.Element {
  const { state } = dialog;
  const inspection = state.phase === 'loading' ? null : state.inspection;
  const [mode, setMode] = useState<WorktreeCreateMode>('new');
  const [newBranch, setNewBranch] = useState('');
  const [existingBranch, setExistingBranch] = useState('');
  const [base, setBase] = useState('');
  const [chosenAgent, setChosenAgent] = useState<AgentId | null>(agent);
  const [copyNotes, setCopyNotes] = useState(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // La base sale elegida: la rama de la carpeta principal.
  useEffect(() => {
    if (inspection === null || base.length > 0) return;
    setBase(inspection.currentBranch ?? inspection.branches[0]?.name ?? '');
  }, [inspection, base]);

  const freeBranches = useMemo(
    () => inspection?.branches.filter((entry) => !entry.checkedOut).map((entry) => entry.name) ?? [],
    [inspection],
  );
  useEffect(() => {
    if (existingBranch.length === 0 && freeBranches[0] !== undefined) setExistingBranch(freeBranches[0]);
  }, [existingBranch, freeBranches]);

  const installed = agents.filter((info) => info.available);
  const branch = mode === 'new' ? newBranch.trim() : existingBranch;
  // Con una rama que ya existe, la base es la de la carpeta principal: contra ella se mira si se integró.
  const effectiveBase = mode === 'new' ? base : (inspection?.currentBranch ?? base);
  const blocker = inspection === null ? null : createBlocker(inspection, branch, mode, effectiveBase);
  const busy = state.phase === 'creating';
  // Después de un fallo se puede volver a intentar: el diálogo sigue con lo que mostró.
  const canCreate = inspection !== null && !busy && branch.length > 0 && blocker === null;

  const submit = (): void => {
    if (!canCreate) return;
    onSubmit({
      branch,
      base: effectiveBase,
      mode,
      copyNotes,
      ...(offerAgentChoice && chosenAgent !== null ? { agent: chosenAgent } : {}),
    });
  };

  const title = t('worktree.create.title');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal worktree-dialog" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-button" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className="modal-hint">{t('worktree.create.intro', { project: dialog.projectName })}</p>

          {state.phase === 'loading' && <p className="modal-hint">{t('worktree.create.loading')}</p>}

          {inspection !== null && (
            <form
              className="worktree-form"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <label className="worktree-field">
                <span className="worktree-label">{t('worktree.create.branch')}</span>
                {mode === 'new' ? (
                  <input
                    className="worktree-input"
                    value={newBranch}
                    onChange={(event) => setNewBranch(event.target.value)}
                    placeholder={t('worktree.create.branchPlaceholder')}
                    spellCheck={false}
                    autoFocus
                    disabled={busy}
                  />
                ) : (
                  <select
                    className="worktree-input"
                    value={existingBranch}
                    onChange={(event) => setExistingBranch(event.target.value)}
                    disabled={busy || freeBranches.length === 0}
                  >
                    {freeBranches.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
              </label>

              <div className="worktree-modes" role="radiogroup">
                <label className="worktree-mode">
                  <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} disabled={busy} />
                  <span>{t('worktree.create.modeNew')}</span>
                  <select
                    className="worktree-input worktree-base"
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                    disabled={busy || mode !== 'new'}
                  >
                    {inspection.branches.map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="worktree-mode">
                  <input
                    type="radio"
                    checked={mode === 'existing'}
                    onChange={() => setMode('existing')}
                    disabled={busy || freeBranches.length === 0}
                  />
                  <span>{t('worktree.create.modeExisting')}</span>
                </label>
                {freeBranches.length === 0 && <p className="modal-hint">{t('worktree.create.noFreeBranch')}</p>}
              </div>

              {offerAgentChoice && installed.length > 1 && (
                <label className="worktree-field">
                  <span className="worktree-label">{t('worktree.create.agent')}</span>
                  <select
                    className="worktree-input"
                    value={chosenAgent ?? ''}
                    onChange={(event) => setChosenAgent(installed.find((info) => info.id === event.target.value)?.id ?? null)}
                    disabled={busy}
                  >
                    {installed.map((info) => (
                      <option key={info.id} value={info.id}>
                        {info.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {blocker !== null && <p className="worktree-problem">{blocker}</p>}

              <h3 className="modal-section">{t('worktree.create.copySection')}</h3>
              {inspection.notes.files === 0 ? (
                <p className="modal-hint">{t('worktree.create.copyNone')}</p>
              ) : (
                <label className="worktree-check">
                  <input type="checkbox" checked={copyNotes} onChange={(event) => setCopyNotes(event.target.checked)} disabled={busy} />
                  <span>
                    {t('worktree.create.copyNotes')}
                    <span className="modal-hint">
                      {' '}
                      {inspection.notes.overCap
                        ? t('worktree.create.overCap', { summary: copySummaryText(inspection.notes) })
                        : t('worktree.create.copyList', {
                            summary: copySummaryText(inspection.notes),
                            list: formatList(inspection.notes.sample),
                          })}
                    </span>
                  </span>
                </label>
              )}
              {inspection.include !== null && (
                <p className="modal-hint">
                  {inspection.include.overCap
                    ? t('worktree.create.includeOverCap', { summary: copySummaryText(inspection.include) })
                    : t('worktree.create.include', { summary: copySummaryText(inspection.include) })}
                </p>
              )}
              {inspection.mainChanges > 0 && (
                <p className="worktree-warning">{t('worktree.create.mainChanges', { count: inspection.mainChanges })}</p>
              )}

              {branch.length > 0 && blocker === null && (
                <>
                  <h3 className="modal-section">{t('worktree.create.folder')}</h3>
                  <p className="worktree-path">{folderPreview(inspection, branch)}</p>
                  <h3 className="modal-section">{t('worktree.create.command')}</h3>
                  <pre className="tool-pre worktree-command">
                    {createCommandPreview(inspection, branch, effectiveBase, mode)}
                  </pre>
                </>
              )}

              {state.phase === 'failed' && <p className="worktree-problem">{state.message}</p>}

              <div className="worktree-actions">
                <button type="button" className="link-button" onClick={onClose}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="primary-button" disabled={!canCreate}>
                  {busy ? t('worktree.create.creating') : t('worktree.create.submit')}
                </button>
              </div>
            </form>
          )}

          {state.phase === 'failed' && inspection === null && <p className="worktree-problem">{state.message}</p>}
        </div>
      </div>
    </div>
  );
}
