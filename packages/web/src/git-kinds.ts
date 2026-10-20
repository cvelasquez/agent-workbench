/**
 * Cómo se dibuja un archivo cambiado: la letra de su cuadradito, su título y
 * su ruta partida en nombre y carpeta. Lo comparten la lista de Cambios y, desde
 * el hito 49, "Ver cambios" de una rama aparte. Sin JSX.
 */

import type { GitChangeKind } from '@agent-workbench/shared';
import type { MessageKey } from './i18n/index.js';

/** Letra que se muestra en el cuadradito de cada archivo. */
export const KIND_BADGE: Readonly<Record<GitChangeKind, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: '?',
  conflict: '!',
};

export const KIND_TITLE: Readonly<Record<GitChangeKind, MessageKey>> = {
  added: 'git.kind.added',
  modified: 'git.kind.modified',
  deleted: 'git.kind.deleted',
  renamed: 'git.kind.renamed',
  copied: 'git.kind.copied',
  'type-changed': 'git.kind.typeChanged',
  untracked: 'git.kind.untracked',
  conflict: 'git.kind.conflict',
};

/**
 * Separa el nombre de su directorio, para que la ruta larga no tape lo que
 * importa.
 *
 * Ojo con la barra final. `git status` no lista una carpeta nueva archivo por
 * archivo: la resume en una sola entrada terminada en `/`: `docs/`. Sin este
 * caso, el ultimo segmento es la cadena vacia y la fila sale sin nombre.
 */
export function splitPath(value: string): { dir: string; name: string; isDirectory: boolean } {
  const isDirectory = value.endsWith('/');
  const clean = isDirectory ? value.slice(0, -1) : value;
  const index = clean.lastIndexOf('/');
  const name = index === -1 ? clean : clean.slice(index + 1);
  return {
    dir: index === -1 ? '' : clean.slice(0, index + 1),
    name: isDirectory ? `${name}/` : name,
    isDirectory,
  };
}
