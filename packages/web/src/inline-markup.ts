/**
 * Marcado en linea del markdown: donde empieza el proximo token y que es.
 *
 * Vive aparte de `Markdown.tsx` por dos razones, y la segunda es la que
 * importa: aca no hay JSX, asi que `pnpm check` —que corre con `tsx`— puede
 * importarlo y probar el parser entero. Lo que quedo en `Markdown.tsx` es solo
 * dibujar, y eso se ve a ojo.
 *
 * **Las URLs sueltas son enlaces.** Es lo que faltaba: la terminal carga
 * `WebLinksAddon` y convierte cualquier `https://…` que aparezca, asi que en la
 * solapa CLI el clic funciona; en el hilo, una URL sin corchetes era texto y el
 * clic no hacia nada. Ahora las dos formas —`[texto](url)` y la URL desnuda—
 * salen por el mismo sitio.
 *
 * El orden de las alternativas no es decorativo. El motor prueba posicion por
 * posicion de izquierda a derecha, y en cada una prueba las alternativas en
 * orden: por eso el enlace de markdown le gana a la URL que lleva adentro, y
 * por eso una URL dentro de `` `codigo` `` no se toca.
 */

/**
 * Una URL desnuda.
 *
 * Sin espacios ni `<>`, sin comillas y sin backtick: todos esos cierran la URL
 * en cualquier texto real. Lo que sobre al final —un punto, un parentesis— lo
 * saca `trimUrl`, porque en la frase "mira https://x.dev/a." el punto es de la
 * frase.
 */
const URL_SOURCE = String.raw`https?:\/\/[^\s<>"'\`]+`;

const INLINE = new RegExp(
  [
    String.raw`(\`[^\`\n]+\`)`,
    String.raw`(\*\*[^*\n]+\*\*)`,
    String.raw`(__[^_\n]+__)`,
    String.raw`(\*[^*\n]+\*)`,
    String.raw`(~~[^~\n]+~~)`,
    String.raw`(\[[^\]\n]+\]\([^)\s]+\))`,
    `(${URL_SOURCE})`,
  ].join('|'),
);

/** Solo esquemas navegables. Un `javascript:` no llega nunca al DOM. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** La misma URL desnuda, para buscarla sola. Ver `nextUrl`. */
const URL_ONLY = new RegExp(URL_SOURCE);

/**
 * La proxima URL desnuda de un texto, o null.
 *
 * Existe aparte de `nextInlineToken` para el texto que **no** es markdown: lo
 * que escribe el usuario se muestra tal cual, sin negritas ni titulos, porque
 * es texto y no un documento. Pero una URL ahi adentro se sigue pudiendo abrir
 * —es lo que uno espera de un link, y lo que la terminal ya hacia— y para eso
 * alcanza con esto.
 */
export function nextUrl(text: string): { index: number; length: number; href: string } | null {
  const match = URL_ONLY.exec(text);
  if (match === null || match.index === undefined) return null;
  const href = trimUrl(match[0]);
  return { index: match.index, length: href.length, href };
}

export type InlineToken =
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'link'; label: string; href: string }
  /** Lo que matcheo pero no se convierte: se muestra tal cual se escribio. */
  | { kind: 'plain'; text: string };

export interface InlineMatch {
  /** Donde empieza dentro del texto que se paso. */
  index: number;
  /** Cuanto texto consume. No siempre es el largo del match: ver `trimUrl`. */
  length: number;
  token: InlineToken;
}

function count(text: string, character: string): number {
  let total = 0;
  for (const char of text) if (char === character) total += 1;
  return total;
}

/**
 * Le saca a una URL lo que en realidad era de la frase.
 *
 * Dos casos, los dos comunes en un mensaje escrito a mano:
 *
 *  - puntuacion final: `…mira https://x.dev/a.` no incluye el punto;
 *  - cierres sin abrir: `(ver https://x.dev/a)` no se lleva el parentesis, pero
 *    `https://es.wikipedia.org/wiki/Ruby_(lenguaje)` si, porque ahi esta
 *    balanceado y el parentesis es parte de la direccion.
 */
export function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.slice(-1);
    if (last.length === 0) return url;

    if ('.,;:!?'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' && count(url, '(') < count(url, ')')) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ']' && count(url, '[') < count(url, ']')) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/**
 * El proximo token del texto, o null si ya no hay marcado.
 *
 * Quien llama muestra como texto lo que haya antes de `index`, dibuja el token,
 * y sigue desde `index + length`.
 */
export function nextInlineToken(text: string): InlineMatch | null {
  const match = INLINE.exec(text);
  if (match === null || match.index === undefined) return null;

  const raw = match[0];
  const index = match.index;
  const at = (token: InlineToken, length = raw.length): InlineMatch => ({ index, length, token });

  if (raw.startsWith('`')) return at({ kind: 'code', text: raw.slice(1, -1) });
  if (raw.startsWith('**') || raw.startsWith('__')) {
    return at({ kind: 'strong', text: raw.slice(2, -2) });
  }
  if (raw.startsWith('~~')) return at({ kind: 'del', text: raw.slice(2, -2) });
  if (raw.startsWith('*')) return at({ kind: 'em', text: raw.slice(1, -1) });

  if (raw.startsWith('[')) {
    const split = raw.indexOf('](');
    const label = raw.slice(1, split);
    const href = raw.slice(split + 2, -1);
    return SAFE_SCHEME.test(href)
      ? at({ kind: 'link', label, href })
      : at({ kind: 'plain', text: raw });
  }

  // URL desnuda. La etiqueta es la direccion misma, ya recortada: mostrar el
  // punto final adentro del enlace es tan feo como incluirlo en el destino.
  const href = trimUrl(raw);
  return at({ kind: 'link', label: href, href }, href.length);
}
