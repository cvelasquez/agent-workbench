/**
 * Las carpetas de un proyecto de Antigravity, de URI a ruta.
 *
 * La CLI y el IDE las guardan como `file:` en tres formas, medidas en los
 * proyectos de una instalacion real: `file:///d%3A/<carpeta>`,
 * `file://C:/<carpeta>` (unidad donde iria el host) y la misma con espacios sin
 * codificar. `url.fileURLToPath` de Node resuelve las tres; lo unico que hace
 * falta es decirle que plataforma manda, que es la del servidor y no la del
 * chequeo.
 */

import { fileURLToPath } from 'node:url';

/** La ruta de una URI `file:`, o null si no es una o no se puede convertir. */
export function fileUriToPath(uri: string, platform: string): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    const result = fileURLToPath(uri, { windows: platform === 'win32' });
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}
