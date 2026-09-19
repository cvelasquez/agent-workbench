/**
 * Frases con código, teclas o negritas adentro (§6.23).
 *
 * La traducción trae las etiquetas (`Pulsa <kbd>Esc</kbd> para salir`) y acá se
 * vuelven elementos de React. Solo se reconocen `<code>`, `<kbd>`, `<b>`,
 * `<strong>`, `<em>` y `<br/>`; cualquier otra cosa se muestra como texto, y
 * React escapa todo: una traducción no puede meter HTML.
 *
 * Los valores se reemplazan después de partir la frase, así que un valor que
 * traiga `<b>` —un nombre de rama, un archivo— sale como texto.
 *
 * Usa React: los módulos que importa `pnpm check` no lo pueden importar.
 */

import { createElement, Fragment, type ReactNode } from 'react';
import { interpolate, template, type MessageKey, type MessageParams } from './index.js';

export type RichTag = 'code' | 'kbd' | 'b' | 'strong' | 'em';

/** Cómo dibujar una etiqueta, cuando no alcanza con el elemento pelado. */
export type RichRenderers = Partial<Record<RichTag, (text: string) => ReactNode>>;

const TAGS = /<(code|kbd|b|strong|em)>([\s\S]*?)<\/\1>|<br\s*\/?>/g;

/** El texto de `key` con sus etiquetas convertidas en elementos. */
export function tRich(key: MessageKey, params?: MessageParams, renderers?: RichRenderers): ReactNode {
  const raw = template(key, params);
  const pieces: ReactNode[] = [];
  let last = 0;
  for (const match of raw.matchAll(TAGS)) {
    const at = match.index ?? 0;
    if (at > last) pieces.push(interpolate(raw.slice(last, at), params));
    const tag = match[1] as RichTag | undefined;
    if (tag === undefined) {
      pieces.push(createElement('br', { key: pieces.length }));
    } else {
      const text = interpolate(match[2] ?? '', params);
      const render = renderers?.[tag];
      pieces.push(
        render === undefined
          ? createElement(tag, { key: pieces.length }, text)
          : createElement(Fragment, { key: pieces.length }, render(text)),
      );
    }
    last = at + match[0].length;
  }
  if (last < raw.length) pieces.push(interpolate(raw.slice(last), params));
  return pieces.length === 1 ? pieces[0] : pieces;
}
