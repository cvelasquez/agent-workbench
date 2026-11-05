import { asRecord, asString } from './validation.js';

export const CODEX_PERMISSION_PRESETS = ['automatic', 'read-only', 'full-access'] as const;
export type CodexPermissionPreset = (typeof CODEX_PERMISSION_PRESETS)[number];

export const CODEX_PERMISSION_RESULT_STATUSES = ['written', 'blocked', 'failed'] as const;
export type CodexPermissionResultStatus = (typeof CODEX_PERMISSION_RESULT_STATUSES)[number];

export const CODEX_PERMISSION_BLOCK_REASONS = [
  'unsupported', 'gone', 'review', 'busy', 'waiting', 'tool-pending', 'not-ready', 'failed',
] as const;
export type CodexPermissionBlockReason = (typeof CODEX_PERMISSION_BLOCK_REASONS)[number];

/** Estado efectivo que Codex registró al aplicar una configuración de hilo. */
export interface CodexPermissionState {
  profileId: string | null;
  approvalPolicy: string | null;
  reviewer: string | null;
  fileSystem: string | null;
  network: string | null;
}

/** Reads only the public fields AWB needs from a rollout event or socket value. */
export function parseCodexPermissionState(value: unknown): CodexPermissionState | null {
  const record = asRecord(value);
  if (record === null) return null;
  const readLabel = (candidate: unknown): string | null => {
    const text = asString(candidate);
    return text !== null && text.length <= 128 ? text : null;
  };
  if ('profileId' in record || 'approvalPolicy' in record || 'reviewer' in record || 'fileSystem' in record || 'network' in record) {
    return {
      profileId: readLabel(record['profileId']),
      approvalPolicy: readLabel(record['approvalPolicy']),
      reviewer: readLabel(record['reviewer']),
      fileSystem: readLabel(record['fileSystem']),
      network: readLabel(record['network']),
    };
  }
  const profile = asRecord(record['active_permission_profile']);
  const permissions = asRecord(record['permission_profile']);
  const fileSystem = asRecord(permissions?.['file_system']);
  return {
    profileId: readLabel(profile?.['id']),
    approvalPolicy: readLabel(record['approval_policy']),
    reviewer: readLabel(record['approvals_reviewer']),
    fileSystem: readLabel(fileSystem?.['type']),
    network: readLabel(permissions?.['network']),
  };
}

/** Parses the finite, allow-listed result status used by the WebSocket. */
export function isCodexPermissionPreset(value: unknown): value is CodexPermissionPreset {
  return typeof value === 'string' && CODEX_PERMISSION_PRESETS.includes(value as CodexPermissionPreset);
}

const COMMANDS: Readonly<Record<CodexPermissionPreset, string>> = {
  automatic: '/permissions :workspace --approval-policy=never --reviewer=user',
  'read-only': '/permissions :read-only --approval-policy=on-request --reviewer=user',
  'full-access': '/permissions :danger-full-access --approval-policy=never --reviewer=user',
};

/** Maps a UI value to a fixed allow-listed command; unknown values are rejected. */
export function codexPermissionCommand(value: unknown): string | null {
  return isCodexPermissionPreset(value)
    ? COMMANDS[value as CodexPermissionPreset]
    : null;
}

/** Returns a known preset only when Codex confirmed the complete combination. */
export function codexPermissionPresetForState(state: CodexPermissionState | null): CodexPermissionPreset | null {
  if (state === null || state.reviewer !== 'user') return null;
  if (state.profileId === ':workspace' && state.approvalPolicy === 'never') return 'automatic';
  if (state.profileId === ':read-only' && state.approvalPolicy === 'on-request') return 'read-only';
  if (state.profileId === ':danger-full-access' && state.approvalPolicy === 'never') return 'full-access';
  return null;
}
