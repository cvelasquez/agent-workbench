/**
 * Donde cae una pestana nueva en la barra.
 *
 * Junto a las de su mismo proyecto, no al final: con las pestanas encogidas y
 * los nombres recortados, tenerlas desparramadas obliga a leerlas una por una,
 * y agrupar es lo que hace que el color del subrayado sirva de algo (CLAUDE.md
 * 6.8).
 *
 * "Mismo proyecto" es la **clave normalizada** del `cwd`, la misma con la que la
 * barra lateral agrupa las sesiones (`normalizeCwdKey`): en Windows,
 * `D:\Mi App` y `d:/mi app/` son una carpeta, y hasta el hito 25 caian en dos
 * grupos porque esto comparaba el texto tal cual. No mira la CLI: el proyecto
 * es el mismo se trabaje con la que se trabaje.
 *
 * Puro y sin disco, para que lo pruebe el chequeo sin cargar `node-pty`.
 *
 * **Vive en `shared` desde el hito 31**, y no en el servidor, porque la regla
 * la necesitan los dos lados: el registro, para insertar la pestana de verdad,
 * y la barra de pestanas del navegador, para dibujar la **provisional** en el
 * sitio donde va a caer (CLAUDE.md 6.8). Al final de la barra, la provisional
 * saltaria de lugar al llegar la de verdad, que es justo el parpadeo que esa
 * senal viene a sacar. Se movio tal cual: una sola implementacion, y la
 * posicion no puede discrepar entre lo que se anuncia y lo que pasa.
 */

import { normalizeCwdKey } from './project-key.js';
import type { TerminalDescriptor, TerminalId } from './models.js';

type Placement = Pick<TerminalDescriptor, 'kind' | 'cwd'>;

/**
 * Indice donde insertar la pestana `descriptor` en `order`. `order.length` si
 * va al final.
 *
 * Una consola va siempre al final: no esta en la barra de pestanas y no agrupa.
 * Una pestana de agente va despues de la **ultima** de agente del mismo
 * proyecto; sin ninguna, al final.
 */
export function insertionIndex(
  order: readonly TerminalId[],
  describe: (terminalId: TerminalId) => Placement | undefined,
  descriptor: Placement,
  platform: string,
): number {
  if (descriptor.kind !== 'agent') return order.length;

  const key = normalizeCwdKey(descriptor.cwd, platform);
  let last = -1;
  for (const [index, terminalId] of order.entries()) {
    const other = describe(terminalId);
    if (other === undefined || other.kind !== 'agent') continue;
    if (normalizeCwdKey(other.cwd, platform) === key) last = index;
  }
  return last === -1 ? order.length : last + 1;
}
