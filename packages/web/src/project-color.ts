/**
 * Un color por proyecto, sacado del `cwd`.
 *
 * Sirve para una sola cosa y hay que tenerla presente al tocarlo: **encontrar
 * de un vistazo las pestanas del mismo proyecto** cuando hay diez abiertas y
 * los nombres estan recortados a veinte pixeles.
 *
 * Tres decisiones:
 *
 *  - **No se configura ni se guarda.** Sale de un hash del `cwd`, asi que es el
 *    mismo entre arranques y entre ventanas sin que haya nada que administrar.
 *    Un selector de color por proyecto seria trabajo para el usuario a cambio
 *    de nada: lo que importa no es *que* color, sino que dos pestanas del mismo
 *    proyecto compartan uno.
 *  - **Doce tonos y no un hue continuo.** Con 360 valores posibles, dos
 *    proyectos distintos salen casi del mismo color y el subrayado deja de
 *    distinguir. Doce escalones estan bastante separados como para leerse de
 *    reojo. Lo que se paga: con mas de doce proyectos abiertos se repite un
 *    tono — y a esa altura el color ya no alcanzaba de todos modos.
 *  - **La saturacion y la luminosidad son fijas por tema**, no parte del hash.
 *    Si variaran, algunos tonos saldrian ilegibles sobre el fondo claro y otros
 *    sobre el oscuro, y eso no se puede arreglar sin una tabla a mano.
 */

/** Cuantos tonos distintos hay. Ver arriba: separados, no infinitos. */
const HUES = 12;

/**
 * Hash estable de una cadena (FNV-1a de 32 bits).
 *
 * Se escribe a mano y no se usa nada del entorno porque tiene que dar lo mismo
 * en cualquier navegador y en cualquier arranque: el color es una identidad
 * visual, y que cambie solo es peor que no tenerlo.
 */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

/**
 * El color de un proyecto, como valor CSS listo para usar.
 *
 * El `cwd` se normaliza —minusculas y separadores unificados— para que
 * `D:\Proyecto` y `d:/proyecto` sean el mismo proyecto, que es lo que son.
 */
export function projectColor(cwd: string): string {
  const key = cwd.toLowerCase().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const hue = (hash(key) % HUES) * (360 / HUES);
  // `light-dark()` no llega a todos los navegadores todavia, asi que la
  // luminosidad la elige el CSS con una variable del tema: aca solo viaja el
  // tono. Ver `--project-color-s` y `--project-color-l` en `styles.css`.
  return `hsl(${hue} var(--project-color-s) var(--project-color-l))`;
}
