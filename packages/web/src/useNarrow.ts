/**
 * Si la ventana es angosta (hito 38, §6.25): `matchMedia` como hook.
 *
 * Es la única pregunta que hace la interfaz para elegir entre el cuerpo de
 * tres columnas y el cascarón de una (`NarrowShell`). La consulta vive en
 * `narrow-layout.ts`, con el resto de lo que decide la vista angosta.
 *
 * Desde el 25-09-2026 hay otra, `useTouch`: si la pantalla es táctil, sin
 * mirar el ancho. La usa el cuadro de escritura para que Enter salte de línea.
 */

import { useEffect, useState } from 'react';
import { NARROW_MEDIA_QUERY, TOUCH_MEDIA_QUERY } from './narrow-layout.js';

function useMediaQuery(media: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(media).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(media);
    const update = (): void => setMatches(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [media]);

  return matches;
}

export function useNarrow(): boolean {
  return useMediaQuery(NARROW_MEDIA_QUERY);
}

/** Una pantalla sin mouse (`hover: none`): un teléfono o una tablet, de cualquier ancho. */
export function useTouch(): boolean {
  return useMediaQuery(TOUCH_MEDIA_QUERY);
}
