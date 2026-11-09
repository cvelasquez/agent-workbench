/**
 * El dialogo de ubicar un proyecto que se movio de carpeta (hito 56, §13.14).
 *
 * Es la vista previa de lo que va a pasar, antes de guardar nada: la carpeta
 * anterior, la nueva, cuantas conversaciones se mueven (las de subcarpetas y
 * ramas aparte incluidas), cuantas tiene ya la carpeta nueva y que bloquea. Se
 * abre despues de elegir la carpeta en el selector del servidor; el cliente no
 * nombra ninguna ruta, solo confirma la vista previa que el servidor guardo
 * (CLAUDE.md 2.4).
 *
 * **Si hay pestanas abiertas en la carpeta anterior, no se puede guardar**: no
 * pueden despertar porque su carpeta no esta, y nada se redirige solo a otra. Se
 * dice cuantas, y cuantas tienen mensajes en cola o programados, que se pierden
 * al cerrarlas. `Escape` cierra, salvo mientras se guarda.
 */

import { useEffect } from 'react';
import type { ProjectLocationPreview } from '@agent-workbench/shared';
import { t } from './i18n/index.js';
import type { LocationStep } from './useProjectLocations.js';

interface ProjectLocationDialogProps {
  step: Exclude<LocationStep, { kind: 'idle' } | { kind: 'choosing' }>;
  onConfirm: () => void;
  onChooseAnother: () => void;
  onCancel: () => void;
}

/** Una fila de cifras: el nombre y el numero, y debajo lo que hay que saber. */
function Fact({
  label,
  count,
  sub = false,
  warn = false,
  hint,
}: {
  label: string;
  count: number;
  sub?: boolean;
  warn?: boolean;
  hint?: string;
}): JSX.Element {
  return (
    <>
      <dt className={`location-fact${sub ? ' location-fact-sub' : ''}${warn ? ' location-fact-warn' : ''}`}>{label}</dt>
      <dd className={`location-count${warn ? ' location-fact-warn' : ''}`}>{count}</dd>
      {hint !== undefined && <dd className="location-hint">{hint}</dd>}
    </>
  );
}

function PreviewBody({ preview }: { preview: ProjectLocationPreview }): JSX.Element {
  return (
    <>
      <dl className="location-folders">
        <dt>{t('locate.dialog.was')}</dt>
        <dd>
          {preview.from.map((folder) => (
            <span className="location-path" key={folder} title={folder}>
              {folder}
            </span>
          ))}
        </dd>
        <dt>{t('locate.dialog.now')}</dt>
        <dd>
          <span className="location-path" title={preview.to}>
            {preview.to}
          </span>
        </dd>
      </dl>

      <dl className="location-facts">
        <Fact label={t('locate.dialog.moving')} count={preview.moving} />
        {preview.inSubfolders > 0 && <Fact label={t('locate.dialog.inSubfolders')} count={preview.inSubfolders} sub />}
        {preview.inDestination > 0 && (
          <Fact label={t('locate.dialog.inDestination')} count={preview.inDestination} hint={t('locate.dialog.inDestinationHint')} />
        )}
        {preview.tabs > 0 && <Fact label={t('locate.dialog.tabs')} count={preview.tabs} warn hint={t('locate.dialog.tabsHint')} />}
        {preview.pending > 0 && (
          <Fact label={t('locate.dialog.pending')} count={preview.pending} warn sub hint={t('locate.dialog.pendingHint')} />
        )}
      </dl>

      <p className="modal-hint">{t('locate.dialog.keeps')}</p>
    </>
  );
}

export function ProjectLocationDialog({ step, onConfirm, onChooseAnother, onCancel }: ProjectLocationDialogProps): JSX.Element {
  const saving = step.kind === 'saving';

  useEffect(() => {
    if (saving) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [saving, onCancel]);

  const preview = step.kind === 'ready' || step.kind === 'saving' ? step.preview : null;
  const blocked = preview !== null && preview.tabs > 0;

  return (
    <div className="modal-backdrop" onClick={saving ? undefined : onCancel}>
      <div className="modal location-modal" role="dialog" aria-label={t('locate.dialog.title')} onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">{t('locate.dialog.title')}</span>
          <button className="icon-button" onClick={onCancel} disabled={saving} title={t('common.closeEsc')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          {step.kind === 'previewing' && <p className="modal-hint">{t('locate.dialog.waiting')}</p>}

          {preview !== null && <PreviewBody preview={preview} />}

          {step.kind === 'failed' && (
            <div className="vault-problem" role="alert">
              <span>{step.problem}</span>
            </div>
          )}

          <div className="location-actions">
            {preview !== null && (
              <button
                className="primary-button"
                onClick={onConfirm}
                disabled={blocked || saving}
                title={blocked ? t('locate.dialog.useBlocked') : undefined}
              >
                {saving ? t('locate.dialog.saving') : t('locate.dialog.use')}
              </button>
            )}
            {step.kind !== 'previewing' && (
              <button className="link-button" onClick={onChooseAnother} disabled={saving}>
                {t('locate.dialog.another')}
              </button>
            )}
            <button className="link-button" onClick={onCancel} disabled={saving}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
