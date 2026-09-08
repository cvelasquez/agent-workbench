/**
 * Preferencias de la ventana.
 *
 * Van a `localStorage` y no al servidor a proposito: son de esta pantalla, no
 * del espacio de trabajo. Dos ventanas abiertas pueden tener el panel de anchos
 * distintos sin pelearse.
 *
 * `localStorage` puede lanzar —modo privado, permisos del navegador—, asi que
 * toda lectura y escritura va envuelta. Sin persistencia se sigue trabajando
 * igual: es una preferencia, no un dato.
 *
 * Vive aparte de `App.tsx` porque el cuadro de escritura guarda su alto por el
 * mismo camino. Dos copias de esto es como terminan divergiendo dos cosas que
 * hacen lo mismo (§6.7).
 */

export function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sin persistencia se sigue igual: es una preferencia, no un dato.
  }
}

/** Un tamano guardado: entero y dentro de rango, o nada. */
export function parseStoredSize(raw: string, min: number, max: number): number | null {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}
