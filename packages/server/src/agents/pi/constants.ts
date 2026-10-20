/**
 * Datos de compatibilidad de Pi: el comando, el paquete, los niveles de
 * razonamiento y la forma de sus ids.
 *
 * Son configuracion, no marca (regla 2.3). Todo medido el 12-10-2026 contra la
 * 1.1.0 en Windows, lanzada en una pty como la lanza el registro de terminales
 * (CLAUDE.md 16), y vuelto a comprobar el 13-10-2026 contra la 1.2.0; donde un
 * valor sale del codigo o de la documentacion del paquete y no de una medicion,
 * se dice.
 */

import type { EffortOption } from '@agent-workbench/shared';

/** Nombre del comando en el PATH. Con npm resuelve a un shim `pi.cmd` (16.1). */
export const PI_COMMAND = 'pi';

/** Nombre para el usuario cuando hay mas de una CLI y para los avisos. */
export const PI_LABEL = 'Pi';

export const PI_INSTALL_URL = 'https://pi.dev';

/**
 * El paquete de npm vigente. Su `package.json`, junto al shim, dice la version
 * sin ejecutar nada, y distingue a Pi de otro programa que se llame `pi`
 * (16.1). El paquete viejo, `@mariozechner/pi-coding-agent`, esta deprecado y
 * no trae `--session-id`: no se acepta.
 */
export const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

/**
 * Los niveles de `/thinking`, en su orden (medido, 16.10). Pi baja el nivel solo
 * si el modelo no lo tiene, asi que se ofrecen todos y manda la CLI.
 *
 * Las etiquetas van en espanol, como las de las demas CLIs: la web traduce las
 * que conoce (`AgentControls`) y muestra estas para las que no.
 */
export const PI_EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: 'off', label: 'Apagado' },
  { value: 'minimal', label: 'Minimo' },
  { value: 'low', label: 'Bajo' },
  { value: 'medium', label: 'Medio' },
  { value: 'high', label: 'Alto' },
  { value: 'xhigh', label: 'Muy alto' },
  { value: 'max', label: 'Maximo' },
];

/**
 * La forma de un id de sesion, la misma que exige Pi (`assertValidSessionId`,
 * segun su codigo): letras, numeros, `.`, `_` y `-`, empezando y terminando en
 * alfanumerico. Con ella el id es un token que pasa entero detras de `cmd /c`
 * (CLAUDE.md 3.1) y no puede leerse como una opcion. El tope de largo es de
 * esta app: un id va dentro de un nombre de archivo.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SESSION_ID_MAX_LENGTH = 128;

export function isPiSessionId(value: string): boolean {
  return value.length <= SESSION_ID_MAX_LENGTH && SESSION_ID_PATTERN.test(value);
}

/**
 * Cuanto despues de lanzar se le puede escribir un mensaje. Medido: la cabecera
 * aparece entre 0,6 y 2,4 s, y un Enter anterior no envia ("Startup is still in
 * progress"): el texto queda en el editor (16.4).
 */
export const PI_READY_AFTER_LAUNCH_MS = 3_000;

/**
 * Separacion minima entre dos Ctrl+C. Segun el codigo de Pi (`handleCtrlC`), el
 * segundo dentro de 500 ms la cierra; medido a 300 ms (cierra) y a 700 ms (no).
 * El margen es para el reloj de la pty.
 */
export const PI_CLEAR_GAP_MS = 750;

/**
 * Las herramientas de una pestana de revision (hito 49): las de leer y la
 * consola, sin `edit` ni `write`. Segun `docs/cli.md` de la 1.3.0, `--tools`
 * con nombres sueltos reemplaza la seleccion entera, y las herramientas de MCP
 * que ningun nombre nombra no se declaran. Medido: la revision uso bash, find,
 * ls y read, y al reanudar con la misma lista el modelo nombro solo esas cinco.
 * Sin comas con espacios: pasa entero por `cmd /c` (§3.1).
 */
export const PI_REVIEW_TOOLS = 'read,bash,grep,find,ls';
