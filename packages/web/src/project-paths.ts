/**
 * Las rutas del proyecto que nombra el hilo (§6.33).
 *
 * Pedido del usuario (13-10-2026): el agente cierra con "los pasos estan en
 * `docs/guia.md`", y para leerlo habia que ir a Archivos y buscarlo a mano.
 * Ahora esa mencion se abre con un clic en la solapa Archivos.
 *
 * Aca esta lo que no toca el DOM ni la red, para que `pnpm check` lo pruebe:
 *
 *  - **Que cuenta como mencion**: lo que va entre acentos graves, y el destino
 *    de un enlace de Markdown que no es una direccion. El texto suelto no: una
 *    frase con barras ("y/o", "24/7") no es una ruta, y no hay forma de saber
 *    donde termina una con espacios.
 *  - **Como se lee una**: sin las comillas, sin el `:12` o `#L12` de una linea,
 *    con `/`, y relativa a la carpeta del proyecto. Una absoluta vale solo si
 *    cae adentro; una que sale con `..`, una direccion o un patron no.
 *  - **Que no es candidata**: una sola palabra sin extension (`main`,
 *    `README`). Casi todo lo que el agente pone entre acentos graves es eso, y
 *    preguntarle al servidor por cada una no sirve de nada.
 *
 * **Lo que sale de aca es un candidato, no un enlace.** Que el archivo exista
 * lo dice el servidor (`files.check`), con su guardia de rutas (§6.3): el
 * cliente sigue sin nombrar una ruta absoluta, y lo que el servidor no confirma
 * queda como texto.
 */

import { FILES_CHECK_MAX_PATH_CHARS } from '@agent-workbench/shared';

/** Donde corre el servidor: decide como se lee una ruta absoluta. */
export interface ProjectRoot {
  /** La carpeta de la pestana. */
  cwd: string;
  /** `process.platform` del servidor. */
  platform: string;
}

/** `src/app.ts:12`, `src/app.ts:12:5`, `src/app.ts:12-20`, `src/app.ts#L12` y `#L12-L20`. */
const LINE_SUFFIX = /(?::\d+(?:[:-]\d+)?|#L\d+(?:-L?\d+)?)$/;
/** Lo que no puede estar en una ruta que se le pregunte al servidor. */
const FORBIDDEN = /[\n\r\t*?<>|"`]/;
const EXTENSION = /\.[A-Za-z0-9_-]{1,12}$/;

const withSlashes = (value: string): string => value.replace(/\\/g, '/');
const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * La parte de una ruta absoluta que queda dentro del proyecto, o null si cae
 * afuera. En Windows no se distinguen mayusculas, como el sistema de archivos.
 */
function insideProject(absolute: string, root: ProjectRoot): string | null {
  const base = withoutTrailingSlash(withSlashes(root.cwd));
  if (base.length === 0) return null;
  const windows = root.platform === 'win32';
  const starts = windows
    ? absolute.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    : absolute.startsWith(`${base}/`);
  return starts ? absolute.slice(base.length + 1) : null;
}

/**
 * La ruta relativa al proyecto de una mencion, con `/`, o null si no puede ser
 * un archivo de el.
 */
export function projectPathOf(mention: string, root: ProjectRoot): string | null {
  let text = mention.trim();
  // Entre comillas, como la deja el boton del arbol; y el `@` con que algunas CLIs mencionan archivos.
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if (quoted !== null) text = (quoted[2] ?? '').trim();
  if (text.startsWith('@')) text = text.slice(1);
  if (text.length === 0 || text.length > FILES_CHECK_MAX_PATH_CHARS || FORBIDDEN.test(text)) return null;
  // Una direccion (`https://…`), el home (`~/…`) o una opcion (`--force`) no son del proyecto.
  if (text.includes('://') || text.startsWith('~') || text.startsWith('-')) return null;

  text = withSlashes(text.replace(LINE_SUFFIX, '')).replace(/[.,;:]+$/, '');
  if (text.length === 0) return null;

  const windows = root.platform === 'win32';
  if (/^[A-Za-z]:\//.test(text) || text.startsWith('//')) {
    // Con unidad o de red: solo si es de este proyecto, y solo en Windows.
    const inside = windows ? insideProject(text, root) : null;
    if (inside === null) return null;
    text = inside;
  } else if (text.startsWith('/')) {
    // Fuera de Windows, absoluta. En Windows, `/d/proyecto/…` es de otra consola: no se adivina.
    const inside = windows ? null : insideProject(text, root);
    if (inside === null) return null;
    text = inside;
  }

  const parts: string[] = [];
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    // Una unidad o un flujo alterno en el medio, o un tramo que empieza o termina en blanco.
    if (segment.includes(':') || segment !== segment.trim()) return null;
    parts.push(segment);
  }
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  // Una palabra sola sin extension no se pregunta: es casi todo lo que va entre acentos graves.
  if (parts.length === 1 && !EXTENSION.test(last)) return null;
  return parts.join('/');
}

/**
 * Lo mismo para el destino de un enlace de Markdown: sin el ancla ni la
 * consulta, y **despues de decodificar** —`C%3A/Windows/win.ini` es una unidad,
 * y mirada antes pasaba por relativa (§6.31)—.
 */
export function projectLinkPathOf(href: string, root: ProjectRoot): string | null {
  const bare = href.split('#')[0]?.split('?')[0] ?? '';
  if (bare.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  // Un esquema (`mailto:`, `file:`) tiene mas de una letra antes de los dos puntos; una unidad, una sola.
  if (/^[a-z][a-z0-9+.-]+:/i.test(decoded)) return null;
  return projectPathOf(decoded, root);
}

const CODE_SPAN = /`([^`\n]+)`/g;
const LINK_TARGET = /\]\(([^)\s]+)\)/g;

/**
 * Los candidatos de un texto del agente, sin repetir: las rutas relativas que
 * vale la pena preguntarle al servidor.
 */
export function pathCandidates(text: string, root: ProjectRoot): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(CODE_SPAN)) {
    const path = projectPathOf(match[1] ?? '', root);
    if (path !== null) found.add(path);
  }
  for (const match of text.matchAll(LINK_TARGET)) {
    const path = projectLinkPathOf(match[1] ?? '', root);
    if (path !== null) found.add(path);
  }
  return [...found];
}

/** Lo que se sabe de una ruta: existe, no existe, o todavia no se pregunto. */
export type KnownPaths = ReadonlyMap<string, boolean>;

/**
 * De los candidatos de un texto **nuevo**, los que hay que preguntar: los que
 * no se conocen y los que la ultima vez no estaban. Un archivo que el agente
 * nombro antes de escribirlo aparece cuando lo vuelve a nombrar; uno que ya se
 * sabe que esta no se pregunta otra vez.
 */
export function pathsToCheck(candidates: readonly string[], known: KnownPaths, pending: ReadonlySet<string>): string[] {
  return candidates.filter((path) => known.get(path) !== true && !pending.has(path));
}

/** Lo que cambia con una respuesta del servidor: cada ruta pedida, si esta o no. */
export function withChecked(known: KnownPaths, asked: readonly string[], existing: readonly string[]): Map<string, boolean> {
  const present = new Set(existing);
  const next = new Map(known);
  for (const path of asked) next.set(path, present.has(path));
  return next;
}
