/**
 * La revisión de una rama por otro agente, y lo que se le pide al de la rama
 * (hito 49, §6.38). Puro: lo prueba `check-worktrees.mjs`.
 *
 * **Todo lo que se le manda a una CLI va en inglés**, con cualquier idioma de
 * la interfaz (§6.23, decisión del usuario del Hito 35). Medido en el paso 0:
 * Claude Code contestó la revisión en español, por las preferencias del
 * usuario, y dejó la línea del veredicto en inglés, como se le pidió.
 *
 * El veredicto se lee de **la última línea de la última respuesta** del
 * revisor. Si esa línea no es ninguna de las dos pedidas, no hay veredicto: la
 * app no adivina qué quiso decir.
 */

import type { ConversationEvent, WorktreeVerdict } from '@agent-workbench/shared';

export const VERDICT_READY = 'Verdict: ready to integrate';
export const VERDICT_CHANGES = 'Verdict: needs changes';

/** El pedido de revisión, tal como lo ve el usuario en el diálogo antes de confirmar. */
export function reviewPrompt(branch: string, base: string): string {
  return (
    `Review the work on this branch, \`${branch}\`, against \`${base}\`. ` +
    `See it with \`git log --oneline ${base}..HEAD\` and \`git diff ${base}...HEAD\`, ` +
    'plus `git status` and `git diff` for anything not committed yet. ' +
    'Read the code around the changes as needed. Do not modify any files and do not commit. ' +
    "Look for bugs, regressions, missing or weak tests, and anything that breaks the rules in this project's CLAUDE.md or AGENTS.md. " +
    'List your findings most severe first, each with the file and line, what goes wrong and when. ' +
    `End with exactly one line: \`${VERDICT_READY}\` or \`${VERDICT_CHANGES}\`.`
  );
}

/**
 * Lo que va en el cuadro de la pestaña de la rama con "Mandar a la rama". La
 * respuesta del revisor va aparte, como ficha de texto pegado: el usuario la lee
 * y borra lo que no comparte antes de mandar.
 */
export function sendBackPrompt(): string {
  return (
    'A reviewer went over this branch and wrote the notes in the pasted text. ' +
    "Fix what you agree with, explain anything you disagree with, run the checks again, and tell me when it's done."
  );
}

/**
 * "Ponerse al día": traer la base con un rebase que hace el agente en su
 * terminal, nunca la app (decisión 2). Con los archivos que chocarían, si el
 * cálculo los dio, y con el aviso de lo que no está commiteado, que no deja
 * hacer el rebase.
 */
export function catchUpPrompt(base: string, conflicts: readonly string[], uncommitted: number): string {
  const expected = conflicts.length > 0 ? ` (expected in ${conflicts.join(', ')})` : '';
  const first = uncommitted > 0 ? 'commit or stash what is not committed yet, ' : '';
  return (
    `Bring this branch up to date with \`${base}\`: ${first}run \`git rebase ${base}\`, ` +
    `resolve any conflicts${expected}, run the checks again, and tell me when it's done.`
  );
}

/**
 * El texto de la última respuesta del agente: el último mensaje suyo con texto
 * y, hacia atrás, los que lo preceden sin herramientas de por medio (una CLI
 * escribe cada bloque de texto en una línea aparte). null si todavía no contestó.
 */
export function lastReplyText(events: readonly ConversationEvent[]): string | null {
  const textOf = (event: ConversationEvent): string =>
    event.parts
      .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
      .join('\n')
      .trim();
  const hasTool = (event: ConversationEvent): boolean => event.parts.some((part) => part.kind === 'tool-call' || part.kind === 'tool-result');

  let end = events.length - 1;
  while (end >= 0) {
    const event = events[end];
    if (event !== undefined && event.role === 'assistant' && textOf(event).length > 0) break;
    end -= 1;
  }
  const last = events[end];
  if (last === undefined) return null;

  // El último texto cuenta aunque venga con una herramienta (una CLI los escribe juntos); los de antes, sólo sin ella.
  const pieces: string[] = [textOf(last)];
  for (let index = end - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.role !== 'assistant' || hasTool(event)) break;
    const text = textOf(event);
    if (text.length > 0) pieces.unshift(text);
  }
  return pieces.join('\n\n');
}

/**
 * El veredicto de una respuesta: su última línea con algo, sin el marcado que
 * un agente le pone (negritas, código, un título, una viñeta) ni el punto
 * final. Las vallas de un bloque de código (```) no cuentan como línea: un
 * agente que cierra con el veredicto dentro de un bloque también lo dijo.
 */
export function readVerdict(reply: string | null): WorktreeVerdict {
  if (reply === null) return 'none';
  const lines = reply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(```|~~~)/.test(line));
  const last = lines[lines.length - 1];
  if (last === undefined) return 'none';
  const clean = last
    .replace(/^[>#\-*+\s]+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\.\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (clean === VERDICT_READY.toLowerCase()) return 'ready';
  if (clean === VERDICT_CHANGES.toLowerCase()) return 'changes';
  return 'none';
}
