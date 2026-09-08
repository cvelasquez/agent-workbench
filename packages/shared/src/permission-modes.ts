/**
 * Los modos de permiso de la CLI: cuales hay, como se llaman y como se cambian.
 *
 * Es el tercer combo del cuadro de escritura, junto al modelo y al esfuerzo, y
 * sigue la misma regla que ellos (§5.4): **se muestra lo observado, no lo
 * pedido.** Lo observado son las lineas `{"type":"permission-mode"}` del
 * archivo de sesion, que la CLI escribe en cada turno y tambien cuando el
 * usuario cambia de modo tecleando `shift+tab` en la solapa CLI.
 *
 * Lo que lo diferencia de los otros dos, y hay que tenerlo presente:
 *
 *  - **No hay comando de barra que lo cambie.** Medido contra la CLI 2.1.260:
 *    el binario solo expone `/permissions`, que abre un dialogo interactivo, y
 *    `--permission-mode` es un argumento de arranque. La unica forma de
 *    cambiarlo en una sesion viva es `shift+tab`, que **cicla**.
 *  - **Por eso hay que saber donde se esta parado.** El ciclo es el de abajo, y
 *    para llegar a un modo se manda `shift+tab` tantas veces como diga la
 *    distancia. Eso es escribir en un TUI con estado, con el mismo cuidado que
 *    las respuestas a una pregunta.
 */

/**
 * El ciclo de `shift+tab`, en orden.
 *
 * Medido contra la CLI 2.1.260 lanzada con `--permission-mode auto`, mandando
 * `ESC[Z` seis veces y leyendo la linea de estado despues de cada una:
 *
 * | Pulsacion | Linea de estado |
 * |---|---|
 * | (inicio) | `auto mode on (shift+tab to cycle)` |
 * | 1 | `manual mode on` |
 * | 2 | `accept edits on (shift+tab to cycle)` |
 * | 3 | `plan mode on (shift+tab to cycle)` |
 * | 4 | `auto mode on` — vuelve a empezar |
 * | 5 y 6 | `manual`, `accept edits` — el ciclo se repite |
 *
 * Son cuatro y el orden se confirmo dos vueltas seguidas. `bypassPermissions`
 * **no** entra en el ciclo: la CLI lo reserva para su propio arranque.
 *
 * Ojo con los nombres: en pantalla dice "manual mode", pero en el archivo esa
 * misma cosa se llama `default`. Manda el archivo, que es de donde lo leemos.
 */
export const PERMISSION_MODE_CYCLE = ['auto', 'default', 'acceptEdits', 'plan'] as const;

export type PermissionMode = (typeof PERMISSION_MODE_CYCLE)[number];

/** Como se lee cada modo en el combo. La CLI los nombra en ingles. */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  auto: 'Automatico',
  default: 'Manual',
  acceptEdits: 'Aceptar ediciones',
  plan: 'Plan',
};

/** Una linea para el titulo del combo: que hace cada modo. */
export const PERMISSION_MODE_HINT: Record<PermissionMode, string> = {
  auto: 'La CLI decide sola que herramientas usar sin preguntar',
  default: 'Pregunta antes de cada herramienta que no este permitida',
  acceptEdits: 'Acepta las ediciones de archivos sin preguntar',
  plan: 'Investiga y propone un plan, sin tocar nada hasta que lo apruebes',
};

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODE_CYCLE as readonly string[]).includes(value);
}

/**
 * Cuantos `shift+tab` hay entre un modo y otro.
 *
 * Devuelve 0 si ya se esta en el destino, y null si alguno de los dos no esta
 * en el ciclo — `bypassPermissions`, o un modo que agregue una version futura.
 * Null significa "no se puede llegar ciclando", y ahi lo correcto es no
 * escribir nada: mandar `shift+tab` a ciegas deja al usuario en un modo que no
 * pidio, que es peor que no hacer nada.
 */
export function cycleDistance(from: string, to: string): number | null {
  const list = PERMISSION_MODE_CYCLE as readonly string[];
  const start = list.indexOf(from);
  const end = list.indexOf(to);
  if (start === -1 || end === -1) return null;
  return (end - start + list.length) % list.length;
}

/**
 * El modo con el que la aplicacion lanza cada pestana.
 *
 * Es `auto` por pedido explicito del usuario (CLAUDE.md 4.8.1) y esta aca
 * porque tambien es el punto de partida del ciclo: mientras el archivo de
 * sesion no diga otra cosa, este es el modo en el que esta la pestana.
 */
export const LAUNCH_PERMISSION_MODE: PermissionMode = 'auto';
