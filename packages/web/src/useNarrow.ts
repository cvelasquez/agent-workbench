/**
 * Si la ventana es angosta (hito 38, §6.25): `matchMedia` como hook.
 *
 * Es la única pregunta que hace la interfaz para elegir entre el cuerpo de
 * tres columnas y el cascarón de una (`NarrowShell`). La consulta vive en
 * `narrow-layout.ts`, con el resto de lo que decide la vista angosta.
 */

import { useEffect, useState } from 'react';
import { NARROW_MEDIA_QUERY } from './narrow-layout.js';

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(NARROW_MEDIA_QUERY);
    const update = (): void => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return narrow;
}
