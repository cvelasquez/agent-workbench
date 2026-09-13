/**
 * El entorno con el que se lanza la CLI.
 *
 * REGLA DURA: el entorno se hereda del proceso padre y **no se le agrega
 * nada**, mucho menos algo de autenticacion. Nada de ANTHROPIC_API_KEY,
 * ANTHROPIC_AUTH_TOKEN ni CLAUDE_CODE_OAUTH_TOKEN. Si el usuario no esta
 * logueado, corre /login dentro de la terminal y la app ni se entera.
 *
 * Lo unico que se quita es CLAUDE_CODE_CHILD_SESSION, que no es de auth y que
 * apaga el guardado del transcript. Esta explicado y justificado en
 * `claudeCodeEnvironment()`.
 */

import type { AgentEnvironment } from '../adapter.js';

/**
 * Marcador que la CLI deja en el entorno de los procesos que lanza.
 *
 * Si una CLI arranca y lo encuentra heredado, **apaga el guardado del
 * transcript**: `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
 * marker`. Sin JSONL no hay historial, ni vista de conversacion, ni medidor de
 * contexto, y `--resume` de esa pestana falla en el arranque siguiente.
 */
export const CHILD_SESSION_MARKER = 'CLAUDE_CODE_CHILD_SESSION';

/**
 * Copia del entorno base, con una unica excepcion.
 *
 * La excepcion es que se **quita** CLAUDE_CODE_CHILD_SESSION. Decidido con el
 * usuario (CLAUDE.md 4.10). El razonamiento: la regla prohibe agregar variables
 * de auth, y esta no es de auth ni se agrega. Una pestana de Agent Workbench no
 * es una sesion anidada dentro de otra conversacion: es una sesion de primer
 * nivel que abrio el usuario, y el marcador solo esta ahi por el accidente de
 * desde donde se lanzo el servidor. Quitarlo devuelve a la CLI su
 * comportamiento normal en vez de restringirlo.
 *
 * Lo que se paga: hoy el marcador solo controla el transcript, pero si una
 * version futura lo usa para otra cosa, quitarlo cambiaria algo que no
 * previmos. Por eso se declara como aviso y la UI lo muestra, en vez de
 * hacerlo callado. El resto de las variables CLAUDE_* se heredan intactas.
 *
 * Las variables sin valor (`undefined`) no pasan: node-pty solo acepta strings.
 */
export function claudeCodeEnvironment(base: NodeJS.ProcessEnv): AgentEnvironment {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === CHILD_SESSION_MARKER) continue;
    env[key] = value;
  }
  return {
    env,
    notice: base[CHILD_SESSION_MARKER] !== undefined ? 'child-session-marker' : null,
  };
}
