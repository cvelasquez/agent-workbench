import type { DraftBox, DraftStash } from '../adapter.js';
import { codexScreenStatus } from './screen-status.js';

const COMPOSER = /^\s*›(?:\s|$)/;
const FOOTER = /^\s*(?:← for agents · \? for shortcuts|\? for shortcuts)\s*$/;
const LOCATION_FOOTER = /^\s*\S.*\s·\s(?:[A-Za-z]:[\\/]|\/|~(?:[\\/]|$))/;
const EMPTY_PROMPT = /^Ask Codex to do anything[.!…]*$/i;

/** Lee solo la caja actual. Sin un pie reconocible, se trata como pantalla desconocida. */
export function readCodexDraftBox(lines: readonly string[]): DraftBox | null {
  if (codexScreenStatus(lines).activity !== 'idle') return null;
  let marker = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (COMPOSER.test(lines[index] ?? '')) {
      marker = index;
      break;
    }
  }
  if (marker < 0) return null;

  let end = -1;
  for (let index = marker + 1; index < lines.length; index += 1) {
    if (FOOTER.test(lines[index] ?? '') || LOCATION_FOOTER.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  if (end < 0) return null;

  const body = lines.slice(marker, end);
  const first = (body[0] ?? '').trim().replace(/^›\s?/, '').trim();
  const remaining = body.slice(1).some((line) => line.trim().length > 0);
  return { text: remaining || (first.length > 0 && !EMPTY_PROMPT.test(first)), saved: false };
}

/** Codex no tiene una tecla verificada para apartar el texto del compositor. */
export const CODEX_DRAFT_STASH: DraftStash = { readBox: readCodexDraftBox };
