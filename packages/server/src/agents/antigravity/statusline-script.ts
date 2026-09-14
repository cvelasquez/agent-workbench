/**
 * La status line opcional de Antigravity CLI: el script que la app instala en su
 * carpeta y la linea que el usuario pega en la configuracion de la CLI.
 *
 * La CLI no escribe en disco si esta trabajando, esperando un permiso o libre,
 * ni cuantos tokens lleva: eso lo publica solo por su status line, un comando
 * que corre en cada cambio de estado con un JSON por stdin. Si el usuario lo
 * configura, el script guarda lo justo en la carpeta de la app y de ahi salen
 * el punto de la pestana, la barra de "esperando", el modo y el medidor.
 *
 * Tres reglas:
 *
 *  - **La app no toca `settings.json`**: muestra el fragmento y el usuario lo
 *    pega. Tampoco manda `/statusline`, que no pone `stack_with_default` y
 *    borraria la linea propia de la CLI.
 *  - **Lista blanca.** El JSON trae el email de la cuenta, la cuota, el plan, el
 *    costo, la carpeta, el titulo y una ruta del IDE. El script toma estado,
 *    modo, modelo y tokens, y nada mas.
 *  - **Nunca falla hacia la CLI ni imprime nada.** Medido: con
 *    `stack_with_default: true` una salida vacia no deja linea en blanco, y un
 *    error se dibuja en el TUI como un bloque de aviso.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATUS_LINE_SCRIPT_NAME } from './constants.js';

/** Sube si cambia lo que el script escribe; el lector exige la misma. */
export const STATUS_LINE_SCRIPT_VERSION = 1;

/**
 * El script, tal cual se escribe. LF, sin dependencias, ESM.
 *
 * Lo que guarda sale de 81 llamadas medidas contra la 1.2.2 (hito 27, paso 0):
 * el modo viene en `cycle_mode` —no en el `execution_mode` de la
 * documentacion— y falta en `default`; `conversation_id` llega vacio hasta el
 * primer mensaje; `transcript_path` apunta a la carpeta del IDE. `keys` son solo
 * los **nombres** de las claves recibidas, sin valores: si una version cambia el
 * formato, dicen que llego en vez de que.
 */
export const STATUS_LINE_SCRIPT = `// Agent Workbench: status line de Antigravity CLI. Lo genera la app: no editar.
// version: ${STATUS_LINE_SCRIPT_VERSION}
//
// La CLI lo corre en cada cambio de estado con un JSON por stdin. Guarda en la
// carpeta de la app solo estado, modo, modelo y tokens de la conversacion. No
// imprime nada, no guarda el email, la cuota, el plan, el costo, la carpeta ni
// el titulo, y nunca falla hacia la CLI.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9_]{1,64}$/;
const MAX_INPUT = 1000000;
const MAX_TEXT = 200;
const MAX_KEYS = 64;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : null);
const rec = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Si la entrada no se cierra nunca, no quedarse colgado.
setTimeout(() => process.exit(0), 5000).unref();

let raw = '';
let tooBig = false;
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => undefined);
process.stdin.on('data', (chunk) => {
  if (tooBig) return;
  raw += chunk;
  if (raw.length > MAX_INPUT) {
    tooBig = true;
    raw = '';
  }
});
process.stdin.on('end', () => {
  if (tooBig) return;
  try {
    const input = rec(JSON.parse(raw));
    if (input === null) return;
    const id = str(input.conversation_id) || str(input.session_id) || '';
    if (!ID.test(id)) return;
    const model = rec(input.model) || {};
    const win = rec(input.context_window) || {};
    const usage = rec(win.current_usage);
    const record = {
      v: ${STATUS_LINE_SCRIPT_VERSION},
      at: Date.now(),
      conversationId: id.toLowerCase(),
      agentState: str(input.agent_state),
      toolConfirmationPending: input.tool_confirmation_pending === true,
      cycleMode: str(input.cycle_mode),
      model: { id: str(model.id), displayName: str(model.display_name), effort: str(model.effort) },
      contextWindow: {
        totalInputTokens: num(win.total_input_tokens),
        totalOutputTokens: num(win.total_output_tokens),
        size: num(win.context_window_size),
        usedPercentage: num(win.used_percentage),
        currentUsage:
          usage === null
            ? null
            : {
                inputTokens: num(usage.input_tokens),
                outputTokens: num(usage.output_tokens),
                cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
                cacheReadInputTokens: num(usage.cache_read_input_tokens),
              },
      },
      cliVersion: str(input.version),
      keys: Object.keys(input).filter((key) => KEY.test(key)).slice(0, MAX_KEYS),
    };
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.join(here, '..', 'agent-status', 'antigravity');
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, record.conversationId + '.json');
    const temp = target + '.' + process.pid + '.tmp';
    const body = JSON.stringify(record);
    writeFileSync(temp, body);
    try {
      renameSync(temp, target);
    } catch {
      // En Windows el rename falla si alguien tiene el destino abierto.
      writeFileSync(target, body);
      rmSync(temp, { force: true });
    }
  } catch {
    // Nunca romper la linea de la CLI.
  }
});
`;

/** La ruta del script dentro de una carpeta de integraciones. */
export function statusLineScriptPath(dir: string): string {
  return path.join(dir, STATUS_LINE_SCRIPT_NAME);
}

/**
 * Escribe el script si no esta o si su contenido no es el esperado (alguien lo
 * edito, o una version nueva de la app lo cambio). Devuelve la ruta. Lanza si
 * no puede escribir: quien lo llama decide si eso importa.
 */
export async function installStatusLineScript(dir: string): Promise<string> {
  const target = statusLineScriptPath(dir);
  let current: string | null = null;
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === STATUS_LINE_SCRIPT) return target;
  await mkdir(dir, { recursive: true });
  await writeFile(target, STATUS_LINE_SCRIPT, 'utf8');
  return target;
}

/** Lo que `cmd` interpreta aunque no haya comillas: con eso no hay linea posible. */
const CMD_SPECIAL = /[&|<>^%"()!\r\n]/;
/** Lo que `sh` interpreta dentro de comillas dobles. */
const SH_SPECIAL = /["$`\\\r\n]/;

/**
 * El comando que corre el script, o null si con esa ruta no hay uno que
 * funcione.
 *
 * **En Windows no puede llevar comillas.** Medido con la 1.2.2: la CLI lo corre
 * con `cmd /c` y el escapado de Go convierte cada `"` en `\"`, que `cmd` no
 * desescapa; node recibia la ruta con las comillas pegadas y no encontraba el
 * modulo. Lo que si funciona, tambien con espacios (16 de 16), es entrar a la
 * carpeta y nombrar el archivo solo. Una carpeta con un caracter que `cmd`
 * interpreta no tiene arreglo sin comillas, y entonces no se ofrece nada.
 *
 * En macOS y Linux, entre comillas dobles (sin medir: no hubo maquina).
 */
export function statusLineCommand(scriptPath: string, platform: string): string | null {
  if (platform === 'win32') {
    const dir = path.win32.dirname(scriptPath);
    const name = path.win32.basename(scriptPath);
    if (CMD_SPECIAL.test(dir) || CMD_SPECIAL.test(name) || /\s/.test(name) || dir.trim() !== dir) return null;
    return `cd /d ${dir} && node ${name}`;
  }
  if (SH_SPECIAL.test(scriptPath)) return null;
  return `node "${scriptPath}"`;
}

/**
 * El fragmento de `settings.json` que el usuario fusiona con el suyo, o null si
 * no hay comando posible (`statusLineCommand`). `stack_with_default` mantiene
 * la linea propia de la CLI: el script no imprime nada.
 */
export function statusLineFragment(scriptPath: string, platform: string): string | null {
  const command = statusLineCommand(scriptPath, platform);
  if (command === null) return null;
  return JSON.stringify({ statusLine: { type: 'command', command, stack_with_default: true } }, null, 2);
}
