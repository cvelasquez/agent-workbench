/**
 * Como se llama un grupo de herramientas del mismo tipo.
 *
 * La CLI resume su propia tanda de acciones en una linea —"Ran 5 shell
 * commands"— y esta es la misma idea: quince tarjetas colapsadas seguidas,
 * cada una con su hora y su etiqueta de esfuerzo al pie, ocupan media pantalla
 * para decir "corri comandos". Lo que se lee de un vistazo es *que* hizo, no
 * cuantas veces llamo a Bash.
 *
 * La lista es corta y explicita a proposito. Un nombre que no este —una
 * herramienta nueva, un MCP— no se fuerza a ninguna categoria: se agrupa con
 * las de su mismo nombre y se muestra tal cual. Inventarle una categoria a lo
 * que no conocemos es como se termina resumiendo mal.
 *
 * Los nombres son los de cada CLI y conviven sin chocar: Codex llama
 * `shell_command` a su consola, `apply_patch` a sus ediciones y `update_plan`
 * a su lista de pasos, y Claude Code no usa ninguno de los tres. Los de OpenCode
 * van en minuscula (`bash`, `read`, `grep`…) y los de Claude Code con
 * mayuscula: la comparacion es exacta, asi que tampoco chocan. Medido en la base
 * de esta maquina, los cuatro mas usados de OpenCode son `read`, `bash`, `grep`
 * y `glob`; sin ellos aca, sus tandas no se plegaban.
 *
 * Vive fuera de `ConversationView.tsx` para que el chequeo la pueda importar
 * sin JSX.
 */

import { t, type MessageKey } from './i18n/index.js';

export interface ToolCategory {
  key: string;
  names: readonly string[];
  /** El resumen de una tanda: "3 comandos de consola", con su plural (§6.23). */
  run: MessageKey;
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    key: 'shell',
    names: ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'shell_command', 'bash'],
    run: 'tools.run.shell',
  },
  { key: 'read', names: ['Read', 'NotebookRead', 'read'], run: 'tools.run.read' },
  { key: 'find', names: ['Glob', 'Grep', 'LS', 'grep', 'glob', 'list'], run: 'tools.run.find' },
  {
    key: 'edit',
    names: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'apply_patch', 'edit', 'write'],
    run: 'tools.run.edit',
  },
  {
    key: 'web',
    names: ['WebSearch', 'WebFetch', 'ToolSearch', 'webfetch', 'websearch', 'codesearch'],
    run: 'tools.run.web',
  },
  { key: 'agent', names: ['Task', 'Agent', 'task'], run: 'tools.run.agent' },
  { key: 'todo', names: ['TodoWrite', 'update_plan', 'todowrite', 'todoread'], run: 'tools.run.todo' },
];

export function toolCategory(name: string): { key: string; known: boolean } {
  const found = TOOL_CATEGORIES.find((entry) => entry.names.includes(name));
  // Sin categoria conocida, la clave es el nombre: dos llamadas seguidas a la
  // misma herramienta siguen siendo una tanda, y el resumen las nombra.
  return found === undefined ? { key: `name:${name}`, known: false } : { key: found.key, known: true };
}

/** "3 comandos de consola", o "3 llamadas a mcp__x" para una sin categoria. */
export function toolRunSummary(key: string, count: number, firstName: string): string {
  const found = TOOL_CATEGORIES.find((entry) => entry.key === key);
  return found === undefined ? t('tools.run.callsTo', { count, name: firstName }) : t(found.run, { count });
}
