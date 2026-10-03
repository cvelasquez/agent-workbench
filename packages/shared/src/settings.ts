/**
 * Lo que la ventana de Ajustes (Hito 41, §6.32) lee y cambia del servidor.
 *
 * Son dos ajustes de `settings.json` que deciden cosas del servidor: que consola
 * abre una nueva, y que CLIs no se usan. El resto de Ajustes —el idioma, el tema
 * de la terminal, que paneles se ven— es de la ventana y no viaja (§6.26).
 *
 * El cliente nunca manda una ruta: elige una consola por su id, de las que el
 * servidor encontro instaladas.
 */

import { isAgentId, type AgentId } from './agents.js';
import { asArrayFiltered, asLiteral, asNonEmptyString, asRecord } from './validation.js';

/**
 * Con que consola abre una nueva. `auto` es la de siempre (en Windows, `pwsh`,
 * `powershell` o `cmd`, en ese orden; en macOS y Linux, `$SHELL`). `login` es la
 * de `$SHELL`, para elegirla aunque no sea la automatica.
 */
export type ConsoleShellId = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'login' | 'bash' | 'sh' | 'zsh';

export const CONSOLE_SHELL_IDS: readonly ConsoleShellId[] = [
  'auto',
  'pwsh',
  'powershell',
  'cmd',
  'git-bash',
  'login',
  'bash',
  'sh',
  'zsh',
];

/** Una consola instalada que se puede elegir. */
export interface ConsoleShellOption {
  id: Exclude<ConsoleShellId, 'auto'>;
  /** Como se la nombra: "PowerShell 7", "Windows PowerShell", "Git Bash". */
  label: string;
}

export interface AppSettingsStatus {
  /** La elegida en `settings.json`. */
  consoleShell: ConsoleShellId;
  /** Las instaladas, en el orden de la automatica. */
  consoleShells: ConsoleShellOption[];
  /** El nombre de la consola que abre una nueva ahora, o null si no hay ninguna. */
  shellName: string | null;
  /** Las CLIs que el usuario apago, segun `settings.json`. */
  disabledAgents: AgentId[];
  /**
   * Las que este arranque dejo apagadas. Apagar o prender una CLI vale al
   * reiniciar la app: si difiere de `disabledAgents`, Ajustes lo dice.
   */
  disabledAtStart: AgentId[];
}

function asConsoleShellId(value: unknown): ConsoleShellId | null {
  return asLiteral(value, CONSOLE_SHELL_IDS);
}

function parseConsoleShellOption(value: unknown): ConsoleShellOption | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asConsoleShellId(record['id']);
  const label = asNonEmptyString(record['label']);
  return id === null || id === 'auto' || label === null ? null : { id, label };
}

/**
 * Las CLIs de una lista que esta build conoce, sin repetir. Lo que no es una
 * —una desconocida, algo que ni es texto— se descarta solo, sin llevarse el
 * resto. null si no es una lista.
 */
export function asAgentIdList(value: unknown): AgentId[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is AgentId => typeof item === 'string' && isAgentId(item)))];
}

export function parseAppSettingsStatus(value: unknown): AppSettingsStatus | null {
  const record = asRecord(value);
  if (record === null) return null;
  const consoleShell = asConsoleShellId(record['consoleShell']);
  const consoleShells = asArrayFiltered(record['consoleShells'], parseConsoleShellOption);
  const rawShellName = record['shellName'];
  const shellName = rawShellName === null ? null : asNonEmptyString(rawShellName);
  const disabledAgents = asAgentIdList(record['disabledAgents']);
  const disabledAtStart = asAgentIdList(record['disabledAtStart']);
  if (consoleShell === null || consoleShells === null || disabledAgents === null || disabledAtStart === null) return null;
  if (rawShellName !== null && shellName === null) return null;
  return { consoleShell, consoleShells, shellName, disabledAgents, disabledAtStart };
}

/** El cambio que pide Ajustes: al menos uno de los dos. */
export interface AppSettingsChange {
  consoleShell?: ConsoleShellId;
  disabledAgents?: AgentId[];
}

export function parseAppSettingsChange(record: Record<string, unknown>): AppSettingsChange | null {
  const rawShell = record['consoleShell'];
  const rawAgents = record['disabledAgents'];
  const consoleShell = rawShell === undefined ? undefined : asConsoleShellId(rawShell);
  const disabledAgents = rawAgents === undefined ? undefined : asAgentIdList(rawAgents);
  if (consoleShell === null || disabledAgents === null) return null;
  if (consoleShell === undefined && disabledAgents === undefined) return null;
  return {
    ...(consoleShell !== undefined ? { consoleShell } : {}),
    ...(disabledAgents !== undefined ? { disabledAgents } : {}),
  };
}
