/**
 * Buscar en un documento abierto, y seguir sus enlaces (Hito 40, §6.31).
 *
 * La busqueda corre sobre el texto **ya dibujado**, no sobre el fuente: un
 * Markdown formateado no tiene los `**` ni los `#` que tiene el archivo, y lo que
 * el usuario ve es lo que busca. Por eso el visor junta los trozos de texto de
 * la pagina, busca aca sobre la union, y con `locateOffset` vuelve de cada
 * posicion al trozo donde cae para marcarla (`useDocSearch`).
 *
 * Dos cuidados:
 *
 *  - **Doblar no cambia el largo.** Las posiciones de la union se usan tal cual
 *    en la pagina; `'İ'.toLowerCase()` son dos caracteres, y correria todas las
 *    marcas que vienen despues. Lo que al doblarse cambia de largo se compara
 *    tal cual.
 *  - **Una coincidencia puede cruzar trozos.** El resaltador parte una linea en
 *    un `<span>` por palabra clave: "const foo" son tres nodos de texto.
 *
 * Puro: lo prueba `check-doc-viewer.mjs`.
 */

/** El texto en minusculas, caracter por caracter, sin cambiar su largo. */
export function foldForSearch(text: string): string {
  let folded = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

/** Donde empieza cada coincidencia, sin distinguir mayusculas y sin solaparse. */
export function findMatches(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const text = foldForSearch(haystack);
  const target = foldForSearch(needle);
  const starts: number[] = [];
  let at = text.indexOf(target);
  while (at !== -1) {
    starts.push(at);
    at = text.indexOf(target, at + target.length);
  }
  return starts;
}

/**
 * En que trozo cae una posicion de la union, y en que lugar de ese trozo.
 * `nodeEnds` son los finales acumulados de cada trozo. Un principio justo en el
 * borde va al trozo siguiente; un final, al que termina ahi.
 */
export function locateOffset(nodeEnds: readonly number[], position: number, edge: 'start' | 'end'): { node: number; offset: number } {
  for (let node = 0; node < nodeEnds.length; node++) {
    const end = nodeEnds[node] ?? 0;
    if (edge === 'start' ? position < end : position <= end) {
      const start = node === 0 ? 0 : (nodeEnds[node - 1] ?? 0);
      return { node, offset: position - start };
    }
  }
  const last = Math.max(0, nodeEnds.length - 1);
  const start = last === 0 ? 0 : (nodeEnds[last - 1] ?? 0);
  return { node: last, offset: (nodeEnds[last] ?? 0) - start };
}

/** La siguiente o la anterior, dando la vuelta. */
export function stepIndex(index: number, count: number, delta: 1 | -1): number {
  if (count === 0) return 0;
  return (index + delta + count) % count;
}

/** true si la ruta es de un Markdown, por su extension. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * Un enlace de un Markdown del proyecto, como ruta relativa a la raiz del
 * proyecto. null si no es un archivo del proyecto: una direccion, un ancla
 * sola, una ruta absoluta o con unidad, o una que sale de la raiz. El servidor
 * vuelve a comprobarla con el guardia de rutas (§6.3); esto solo decide que
 * enlaces se abren en la app.
 */
export function resolveDocLink(fromPath: string, href: string): string | null {
  const bare = href.split('#')[0]?.split('?')[0] ?? '';
  if (bare.length === 0) return null;
  /*
    Todo se mira **despues** de decodificar: `C%3A/Windows/win.ini` es una
    unidad, y mirado antes pasaba como relativa (lo encontro la revision de la
    0.5.0). Un esquema (https:, mailto:), una raiz o una ruta UNC no son del
    proyecto, y un tramo con dos puntos —una unidad, un flujo alterno de
    Windows— tampoco.
  */
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('/') || decoded.startsWith('\\')) return null;
  const parts = fromPath.split('/').slice(0, -1);
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (segment.includes(':')) return null;
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? null : parts.join('/');
}
