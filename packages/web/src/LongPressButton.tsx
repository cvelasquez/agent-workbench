/**
 * Un boton con toque largo (hito 38, §6.25): en la fila de una sesion, lo que
 * en la PC es Ctrl+clic para seleccionar. El gancho no puede llamarse dentro
 * de un `map`, y por eso la fila lo toma de aca.
 */

import type { ButtonHTMLAttributes } from 'react';
import { useLongPress } from './long-press.js';

interface LongPressButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  onLongPress: () => void;
}

export function LongPressButton({ onLongPress, ...rest }: LongPressButtonProps): JSX.Element {
  const handlers = useLongPress(onLongPress);
  return <button {...rest} {...handlers} />;
}
