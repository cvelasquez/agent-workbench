/**
 * La status line opcional de Claude Code (hito 47, §4.17): el script que la app
 * instala en su carpeta y la linea que el usuario pega en `~/.claude/settings.json`.
 *
 * La CLI no deja en disco cuanto se uso de los limites del plan de la cuenta:
 * lo publica solo por su status line, un comando que corre con un JSON por
 * stdin (`rate_limits.five_hour` y `rate_limits.seven_day`). Si el usuario lo
 * configura, el script guarda lo justo en la carpeta de la app y de ahi sale el
 * medidor del plan.
 *
 * Cuatro reglas, las mismas que la de Antigravity (`antigravity/statusline-script.ts`)
 * salvo la ultima:
 *
 *  - **La app no toca `settings.json`**: muestra el fragmento y el usuario lo
 *    pega.
 *  - **Lista blanca.** El JSON trae la carpeta, el transcript, el costo y el
 *    modelo. El script toma las dos ventanas y el id de la sesion, y nada mas.
 *  - **Nunca falla hacia la CLI**: un error no corta la linea.
 *  - **Imprime una linea corta**, los dos limites, para que la solapa CLI
 *    tambien los muestre. La CLI admite una sola status line: la de la app
 *    reemplaza a otra que hubiera, y el dialogo lo dice.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Nombre del script dentro de `integrations/`. */
export const CLAUDE_STATUS_LINE_SCRIPT_NAME = 'claude-code-statusline.mjs';

/** Sube si cambia lo que el script escribe. */
export const CLAUDE_STATUS_LINE_SCRIPT_VERSION = 1;

/**
 * El script, tal cual se escribe. LF, sin dependencias, ESM.
 *
 * Lo que lee sale de la documentacion de la CLI y de una medicion contra la
 * 2.1.303 (hito 47, paso 0): la primera corrida, al abrir la sesion, no trae
 * `rate_limits`; desde la primera respuesta trae `five_hour` y `seven_day`, cada
 * uno con `used_percentage` (entero, de 0 a 100) y `resets_at` en segundos.
 *
 * `observedAt` es desde cuando la sesion ve ese valor: si el registro anterior
 * de la misma sesion decia lo mismo, se conserva. Una sesion quieta vuelve a
 * correr el script con lo que vio hace una hora, y eso no puede pasar por
 * nuevo frente a otra sesion que acaba de medir.
 */
export const CLAUDE_STATUS_LINE_SCRIPT = `// Agent Workbench: status line de Claude Code. Lo genera la app: no editar.
// version: ${CLAUDE_STATUS_LINE_SCRIPT_VERSION}
//
// La CLI lo corre con un JSON por stdin. Guarda en la carpeta de la app solo los
// limites del plan (las 5 horas y la semana) y el id de la sesion, e imprime una
// linea corta con los dos. No guarda la carpeta, el transcript, el costo ni el
// modelo, y nunca falla hacia la CLI.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9_]{1,64}$/;
const MAX_INPUT = 1000000;
const MAX_KEYS = 64;
const WINDOWS = [
  { id: 'five_hour', minutes: 300, label: '5h' },
  { id: 'seven_day', minutes: 10080, label: 'week' },
];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Si la entrada no se cierra nunca, no quedarse colgado.
setTimeout(() => process.exit(0), 5000).unref();

function left(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return days + 'd ' + hours + 'h';
  if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
  return (minutes % 60) + 'm';
}

function previousWindows(file) {
  try {
    const old = rec(JSON.parse(readFileSync(file, 'utf8')));
    return old !== null && Array.isArray(old.planLimits) ? old.planLimits : [];
  } catch {
    return [];
  }
}

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
  let line = '';
  try {
    const input = rec(JSON.parse(raw));
    if (input === null) return;
    const id = typeof input.session_id === 'string' ? input.session_id : '';
    if (!ID.test(id)) return;
    const limits = rec(input.rate_limits) || {};
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.join(here, '..', 'agent-status', 'claude-code');
    const target = path.join(dir, id.toLowerCase() + '.json');
    const before = previousWindows(target);
    const now = Date.now();
    const planLimits = [];
    const shown = [];
    for (const window of WINDOWS) {
      const value = rec(limits[window.id]);
      if (value === null) continue;
      const used = num(value.used_percentage);
      const resets = num(value.resets_at);
      if (used === null || used < 0) continue;
      const resetsAt = resets !== null && resets > 0 ? resets * 1000 : null;
      const same = before.find((old) => rec(old) !== null && old.id === window.id && old.usedPercent === used && old.resetsAt === resetsAt);
      const observedAt = same !== undefined && num(same.observedAt) !== null ? same.observedAt : now;
      planLimits.push({ id: window.id, minutes: window.minutes, usedPercent: used, resetsAt, observedAt });
      const percent = Math.round(used) + '%';
      const text = window.label + ' ' + (used >= 90 ? '\\u001b[31m' + percent + '\\u001b[0m' : percent);
      shown.push(resetsAt === null ? text : text + ' (' + left(resetsAt - now) + ')');
    }
    line = shown.join(' \\u00b7 ');
    const record = {
      v: ${CLAUDE_STATUS_LINE_SCRIPT_VERSION},
      at: now,
      sessionId: id.toLowerCase(),
      planLimits,
      keys: Object.keys(input).filter((key) => KEY.test(key)).slice(0, MAX_KEYS),
    };
    mkdirSync(dir, { recursive: true });
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
  if (line.length > 0) process.stdout.write(line + '\\n');
});
`;

/** La ruta del script dentro de una carpeta de integraciones. */
export function claudeStatusLineScriptPath(dir: string): string {
  return path.join(dir, CLAUDE_STATUS_LINE_SCRIPT_NAME);
}

/**
 * Escribe el script si no esta o si su contenido no es el esperado (alguien lo
 * edito, o una version nueva de la app lo cambio). Devuelve la ruta. Lanza si
 * no puede escribir: quien lo llama decide si eso importa.
 */
export async function installClaudeStatusLineScript(dir: string): Promise<string> {
  const target = claudeStatusLineScriptPath(dir);
  let current: string | null = null;
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === CLAUDE_STATUS_LINE_SCRIPT) return target;
  await mkdir(dir, { recursive: true });
  await writeFile(target, CLAUDE_STATUS_LINE_SCRIPT, 'utf8');
  return target;
}

/** Lo que Git Bash y PowerShell interpretan dentro de comillas dobles. */
const QUOTED_SPECIAL = /["$`\r\n]/;

/**
 * El comando que corre el script, o null si con esa ruta no hay uno que
 * funcione.
 *
 * **Con barras normales y entre comillas dobles.** Medido con la 2.1.303: en
 * Windows la CLI corre la linea con Git Bash (o con PowerShell si no esta), y
 * Git Bash se come las barras invertidas de una ruta. `node "D:/carpeta con
 * espacio/x.mjs"` funciono; `node` acepta las barras normales, y las dos
 * consolas pasan la ruta entera. Una ruta con `"`, `$` o un acento grave no
 * tiene arreglo dentro de comillas dobles, y entonces no se ofrece nada. En
 * macOS y Linux, lo mismo con la ruta tal cual (sin medir: no hubo maquina).
 */
export function claudeStatusLineCommand(scriptPath: string, platform: string): string | null {
  const target = platform === 'win32' ? scriptPath.replace(/\\/g, '/') : scriptPath;
  if (QUOTED_SPECIAL.test(target) || (platform !== 'win32' && target.includes('\\'))) return null;
  return `node "${target}"`;
}

/**
 * El fragmento de `settings.json` que el usuario fusiona con el suyo, o null si
 * no hay comando posible (`claudeStatusLineCommand`).
 */
export function claudeStatusLineFragment(scriptPath: string, platform: string): string | null {
  const command = claudeStatusLineCommand(scriptPath, platform);
  if (command === null) return null;
  return JSON.stringify({ statusLine: { type: 'command', command } }, null, 2);
}
