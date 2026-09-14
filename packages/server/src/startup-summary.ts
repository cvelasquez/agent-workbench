/**
 * Las lineas del arranque que hablan de las CLIs.
 *
 * Aparte de `index.ts` para poder probarlas: `index.ts` arranca el servidor al
 * importarse.
 *
 * La regla es que se cuentan las CLIs **disponibles**, no las registradas. Con
 * dos adaptadores registrados, rotular por registradas le mostraria a quien solo
 * tiene Claude Code una linea "NO ENCONTRADA" y el texto de instalacion de otra
 * CLI en cada arranque, por algo que no pidio. Asi:
 *
 *  - **Una disponible**: las lineas de siempre, sin nombre, y nada de las que
 *    faltan.
 *  - **Varias**: una por disponible, cada una con su nombre.
 *  - **Ninguna**: el texto de la primera registrada —la de siempre— y una linea
 *    que nombra las demas.
 *
 * Y una linea mas, `CLIs disponibles`, con los ids: es lo que mira la demo para
 * negarse a capturar si encontro una CLI de verdad.
 *
 * Debajo de una CLI disponible con status line opcional (hito 27, Antigravity
 * CLI), como esta configurada: sin ella la pestana no tiene estado ni medidor,
 * y es lo primero que conviene saber si eso no aparece. Las demas no la tienen
 * y no ganan ninguna linea.
 */

import type { AgentId, StatusLineState } from '@agent-workbench/shared';

export interface StartupAgent {
  id: AgentId;
  label: string;
  /** Primera linea de `--version`, o null. */
  version: string | null;
  /** Donde esta el binario, o null si la CLI no se encontro. */
  resolvedPath: string | null;
  missingMessage: string | null;
  /**
   * Lo que va despues de `Historial`, o null (`AgentAdapter.startupHistoryNote`).
   * Ausente: null.
   */
  historyNote?: string | null;
  /**
   * Como esta la status line opcional de esa CLI (`AgentInfo.statusLine`), o
   * null si no tiene. Ausente: null. Solo la declara Antigravity CLI (hito 27).
   */
  statusLine?: StatusLineState | null;
}

/** Rotulo de la linea de la status line. */
export const STATUS_LINE_LABEL = 'Status line';

/** Lo que se imprime de cada estado: corto, y diciendo que se pierde sin ella. */
export function statusLineStartupText(state: StatusLineState): string {
  switch (state) {
    case 'active':
      return 'configurada';
    case 'missing':
      return 'sin configurar (sin estado ni medidor; se configura desde el medidor)';
    case 'other-command':
      return 'hay otra configurada (sin estado ni medidor)';
    case 'disabled':
      return 'desactivada con enabled: false';
    case 'unreadable':
      return 'no pude leer su settings.json';
  }
}

/** Prefijo de la linea con los ids. La demo la busca por este texto. */
export const AVAILABLE_AGENTS_LABEL = 'CLIs disponibles';

/** Rotulo de la linea del historial. La demo se niega a capturar si la ve. */
export const HISTORY_LABEL = 'Historial';

/**
 * Las lineas, ya con su sangria, en el orden en que se imprimen.
 *
 * La del historial va debajo de las de su CLI cuando esas lineas estan; si la
 * CLI no se encontro, al final y con su nombre, porque no hay debajo de que
 * ponerla. Sin nota no hay linea: con Claude Code y Codex nada cambia.
 */
export function startupAgentLines(agents: readonly StartupAgent[]): string[] {
  const available = agents.filter((agent) => agent.resolvedPath !== null);
  const lines = [
    `  ${AVAILABLE_AGENTS_LABEL}  ${available.length === 0 ? 'ninguna' : available.map((agent) => agent.id).join(', ')}`,
  ];

  for (const agent of available) {
    const title = available.length === 1 ? 'CLI          ' : `CLI (${agent.label})  `;
    lines.push(`  ${title}${agent.version ?? 'version desconocida'}`);
    lines.push(`  Binario      ${agent.resolvedPath ?? ''}`);
    const note = agent.historyNote ?? null;
    if (note !== null) lines.push(`  ${HISTORY_LABEL}    ${note}`);
    const statusLine = agent.statusLine ?? null;
    if (statusLine !== null) lines.push(`  ${STATUS_LINE_LABEL}  ${statusLineStartupText(statusLine)}`);
  }

  const first = agents[0];
  if (available.length === 0 && first !== undefined) {
    lines.push('  CLI          NO ENCONTRADA');
    if (first.missingMessage !== null) lines.push('', `  ${first.missingMessage}`);
    const others = agents.slice(1).map((agent) => agent.label);
    if (others.length > 0) lines.push(`  Tambien funciona con: ${others.join(', ')}`);
  }

  for (const agent of agents) {
    const note = agent.historyNote ?? null;
    if (agent.resolvedPath === null && note !== null) lines.push(`  ${HISTORY_LABEL} (${agent.label})  ${note}`);
  }
  return lines;
}
