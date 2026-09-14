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

export interface ToolCategory {
  key: string;
  names: readonly string[];
  label: string;
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  {
    key: 'shell',
    names: ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'shell_command', 'bash'],
    label: 'comandos de consola',
  },
  { key: 'read', names: ['Read', 'NotebookRead', 'read'], label: 'archivos leidos' },
  { key: 'find', names: ['Glob', 'Grep', 'LS', 'grep', 'glob', 'list'], label: 'busquedas en el proyecto' },
  {
    key: 'edit',
    names: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'apply_patch', 'edit', 'write'],
    label: 'ediciones',
  },
  {
    key: 'web',
    names: ['WebSearch', 'WebFetch', 'ToolSearch', 'webfetch', 'websearch', 'codesearch'],
    label: 'busquedas',
  },
  { key: 'agent', names: ['Task', 'Agent', 'task'], label: 'subagentes' },
  { key: 'todo', names: ['TodoWrite', 'update_plan', 'todowrite', 'todoread'], label: 'listas de tareas' },
];

export function toolCategory(name: string): { key: string; label: string | null } {
  const found = TOOL_CATEGORIES.find((entry) => entry.names.includes(name));
  // Sin categoria conocida, la clave es el nombre: dos llamadas seguidas a la
  // misma herramienta siguen siendo una tanda, y el resumen las nombra.
  return found === undefined ? { key: `name:${name}`, label: null } : found;
}
