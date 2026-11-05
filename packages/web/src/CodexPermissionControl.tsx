import {
  codexPermissionPresetForState,
  type CodexPermissionBlockReason,
  type CodexPermissionPreset,
  type CodexPermissionState,
} from '@agent-workbench/shared';
import { t, type MessageKey } from './i18n/index.js';
import type { CodexPermissionRequest } from './useConversation.js';

const HINTS: Readonly<Record<CodexPermissionPreset, MessageKey>> = {
  automatic: 'controls.permission.automaticHint',
  'read-only': 'controls.permission.readOnlyHint',
  'full-access': 'controls.permission.fullAccessHint',
};

const REASONS: Readonly<Record<CodexPermissionBlockReason, MessageKey>> = {
  unsupported: 'controls.permission.error.unsupported',
  gone: 'controls.permission.error.gone',
  review: 'controls.permission.error.review',
  busy: 'controls.permission.error.busy',
  waiting: 'controls.permission.error.waiting',
  'tool-pending': 'controls.permission.error.toolPending',
  'not-ready': 'controls.permission.error.notReady',
  failed: 'controls.permission.error.failed',
};

interface CodexPermissionControlProps {
  disabled: boolean;
  state: CodexPermissionState | null;
  request: CodexPermissionRequest | null;
  onChange: (preset: CodexPermissionPreset) => void;
}

/** Shows only the effective preset observed by the server; requests stay pending until Codex confirms them. */
export function CodexPermissionControl({ disabled, state, request, onChange }: CodexPermissionControlProps): JSX.Element {
  const preset = codexPermissionPresetForState(state);
  const value = preset ?? (state === null ? '__unknown' : '__custom');
  const busy = request?.status === 'writing' || request?.status === 'awaiting';
  let feedback: string | null = null;
  if (request?.status === 'writing') feedback = t('controls.permission.pending');
  else if (request?.status === 'awaiting') feedback = t('controls.permission.awaiting');
  else if (request?.status === 'unconfirmed') feedback = t('controls.permission.unconfirmed');
  else if (request?.status === 'blocked') {
    feedback = t(request.reason === undefined ? 'controls.permission.error.failed' : REASONS[request.reason]);
  }

  return (
    <div className="codex-permission-control">
      <select
        className="agent-select agent-select-permission"
        value={value}
        disabled={disabled || busy}
        aria-label={t('controls.permission.label')}
        title={preset === null ? t('controls.permission.unknownHint') : t(HINTS[preset])}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'automatic' || next === 'read-only' || next === 'full-access') onChange(next);
        }}
      >
        {preset === null && (
          <option value={state === null ? '__unknown' : '__custom'} disabled>
            {t(state === null ? 'controls.permission.unknown' : 'controls.permission.custom')}
          </option>
        )}
        <option value="automatic">{t('controls.permission.automatic')}</option>
        <option value="read-only">{t('controls.permission.readOnly')}</option>
        <option value="full-access">{t('controls.permission.fullAccess')}</option>
      </select>
      {feedback !== null && <span className="codex-permission-status" role="status">{feedback}</span>}
    </div>
  );
}
