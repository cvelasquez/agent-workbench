/**
 * El tamano de letra del hilo: tres pasos fijos y un boton que los rota (§6.22).
 *
 * Puro y sin React, para que `pnpm check` lo pueda importar: la web no tiene
 * tests. El hook que guarda la preferencia esta en `useThreadFont.ts`.
 *
 * "Chico" es lo que el hilo midio siempre (12,5 px); "normal" lo lleva a los
 * 14 px de la terminal, y es el valor por defecto porque es lo que se pidio;
 * "grande", a 16. La hoja de estilos multiplica cada regla del hilo por
 * `--thread-scale`, asi que en "chico" salen los mismos pixeles de antes.
 */

export type ThreadFontSize = 's' | 'm' | 'l';

export const THREAD_FONT_SIZES: readonly ThreadFontSize[] = ['s', 'm', 'l'];

export const DEFAULT_THREAD_FONT_SIZE: ThreadFontSize = 'm';

export const THREAD_FONT_STORAGE_KEY = 'agent-workbench.thread-font';

export const THREAD_FONT_LABEL: Readonly<Record<ThreadFontSize, string>> = {
  s: 'chica',
  m: 'normal',
  l: 'grande',
};

/** El paso siguiente del ciclo; del ultimo vuelve al primero. */
export function nextThreadFontSize(current: ThreadFontSize): ThreadFontSize {
  const index = THREAD_FONT_SIZES.indexOf(current);
  return THREAD_FONT_SIZES[(index + 1) % THREAD_FONT_SIZES.length] ?? DEFAULT_THREAD_FONT_SIZE;
}

/** Lo guardado, o null si no es uno de los tres. */
export function parseThreadFontSize(raw: string): ThreadFontSize | null {
  return raw === 's' || raw === 'm' || raw === 'l' ? raw : null;
}

/** El titulo del boton: que hay puesto y que pone el clic. */
export function threadFontTitle(current: ThreadFontSize): string {
  return `Tamaño de letra: ${THREAD_FONT_LABEL[current]} (clic: ${THREAD_FONT_LABEL[nextThreadFontSize(current)]})`;
}
