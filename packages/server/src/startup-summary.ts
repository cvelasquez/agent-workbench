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
 */

import type { AgentId } from '@agent-workbench/shared';

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
