/**
 * Traza opcional del servidor.
 *
 * Se activa con `AGENT_WORKBENCH_DEBUG=1`. Apagada no cuesta nada: la
 * comprobacion es una constante evaluada al cargar el modulo.
 *
 * Existe porque los problemas de este servidor son de flujo —un mensaje que no
 * llega, un oyente que no se engancha— y sin ver la secuencia solo queda
 * adivinar.
 */

const enabled = process.env['AGENT_WORKBENCH_DEBUG'] === '1';

export function debugLog(scope: string, message: string): void {
  if (!enabled) return;
  console.log(`[${scope}] ${message}`);
}

export const debugEnabled = enabled;
