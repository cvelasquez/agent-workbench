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
 *
 * En ingles, como todo lo que imprime el servidor (hito 34, D19): la consola no
 * sabe en que idioma esta nadie, y el ingles es el idioma por defecto.
 */

import { SUPPORT_URL, type AgentId, type RemoteAccessState, type ServerText, type StatusLineState } from '@agent-workbench/shared';

export interface StartupAgent {
  id: AgentId;
  label: string;
  /** Primera linea de `--version`, o null. */
  version: string | null;
  /** Donde esta el binario, o null si la CLI no se encontro. */
  resolvedPath: string | null;
  /** El aviso de CLI no instalada que va a la web (`cliMissing`); aca se escribe en ingles. */
  missingMessage: ServerText | null;
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
      return 'configured';
    case 'missing':
      return 'not configured (no status or meter; set it up from the meter)';
    case 'other-command':
      return 'another one is configured (no status or meter)';
    case 'disabled':
      return 'disabled with enabled: false';
    case 'unreadable':
      return "couldn't read its settings.json";
  }
}

/** Rotulo de la linea del acceso remoto (hito 37). */
export const REMOTE_ACCESS_LABEL = 'Remote access';

/**
 * La linea del acceso remoto, o null. **Apagado no hay linea**: quien no lo usa
 * ve el arranque de siempre, que es la regla de todo lo opcional de este
 * archivo. Encendido conviene verlo en cada arranque: es lo que deja entrar a
 * otro equipo.
 */
export function remoteAccessStartupLine(
  state: RemoteAccessState,
  port: number,
  pairedDevices: number,
): string | null {
  switch (state) {
    case 'off':
      return null;
    case 'active':
      return `  ${REMOTE_ACCESS_LABEL}  on, port ${port}, ${pairedDevices} paired device${pairedDevices === 1 ? '' : 's'}`;
    case 'port-busy':
      return `  ${REMOTE_ACCESS_LABEL}  NOT WORKING: port ${port} is busy (another Agent Workbench, or another program)`;
    case 'restart-needed':
      // Al arrancar no pasa: el puerto se acaba de elegir con estos mismos ajustes.
      return `  ${REMOTE_ACCESS_LABEL}  on, takes effect after a restart`;
  }
}

/** Prefijo de la linea con los ids. La demo la busca por este texto. */
export const AVAILABLE_AGENTS_LABEL = 'Available CLIs';

/** Rotulo de la linea del historial. La demo se niega a capturar si la ve. */
export const HISTORY_LABEL = 'History';

/**
 * El aviso de CLI no instalada, en ingles. La web lo arma con su clave
 * (`cliMissing`) en el idioma de cada ventana; la consola no tiene diccionario.
 */
function missingText(text: ServerText): string {
  // Un texto suelto (`raw`) sale tal cual: es lo que usan los chequeos.
  if (text.key !== 'cliMissing') {
    const raw = text.params?.['text'];
    return typeof raw === 'string' ? raw : text.key;
  }
  const command = String(text.params?.['command'] ?? '');
  const url = String(text.params?.['url'] ?? '');
  return (
    `The "${command}" command wasn't found in the PATH. Agent Workbench uses the CLI you already ` +
    `have installed: it doesn't include or download it. Install it from ${url} and start again.`
  );
}

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
    `  ${AVAILABLE_AGENTS_LABEL}  ${available.length === 0 ? 'none' : available.map((agent) => agent.id).join(', ')}`,
  ];

  for (const agent of available) {
    const title = available.length === 1 ? 'CLI          ' : `CLI (${agent.label})  `;
    lines.push(`  ${title}${agent.version ?? 'unknown version'}`);
    lines.push(`  Binary       ${agent.resolvedPath ?? ''}`);
    const note = agent.historyNote ?? null;
    if (note !== null) lines.push(`  ${HISTORY_LABEL}      ${note}`);
    const statusLine = agent.statusLine ?? null;
    if (statusLine !== null) lines.push(`  ${STATUS_LINE_LABEL}  ${statusLineStartupText(statusLine)}`);
  }

  const first = agents[0];
  if (available.length === 0 && first !== undefined) {
    lines.push('  CLI          NOT FOUND');
    if (first.missingMessage !== null) lines.push('', `  ${missingText(first.missingMessage)}`);
    const others = agents.slice(1).map((agent) => agent.label);
    if (others.length > 0) lines.push(`  Also works with: ${others.join(', ')}`);
  }

  for (const agent of agents) {
    const note = agent.historyNote ?? null;
    if (agent.resolvedPath === null && note !== null) lines.push(`  ${HISTORY_LABEL} (${agent.label})  ${note}`);
  }
  return lines;
}

/** Rotulo de la linea que invita a apoyar el proyecto (§6.28). */
export const SUPPORT_LABEL = 'Support';

/**
 * La linea de apoyo, al final del arranque y en cada arranque: una linea en una
 * consola que casi nadie mira. La direccion es la misma que la de la web.
 */
export function supportStartupLine(): string {
  return `  ${SUPPORT_LABEL}      If Agent Workbench is useful to you, consider supporting it: ${SUPPORT_URL}`;
}

/**
 * La misma linea en amarillo, para que resalte entre las demas (pedido del
 * usuario). Solo cuando la consola dibuja colores: sin terminal, o con
 * `NO_COLOR`, va la lisa, y un log no gana secuencias de escape.
 */
export function supportStartupLineColored(): string {
  return `\x1b[33m${supportStartupLine()}\x1b[0m`;
}
