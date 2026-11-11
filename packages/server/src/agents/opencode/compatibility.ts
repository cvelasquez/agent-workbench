/** El contrato de OpenCode 2 es distinto del de OpenCode 1. */
export type OpenCodeProtocol = 1 | 2;

export function openCodeProtocol(version: string | null): OpenCodeProtocol {
  return /(?:^|\s)v?2\./i.test(version ?? '') ? 2 : 1;
}
