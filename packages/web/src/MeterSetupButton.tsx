/**
 * "Configurar" de un medidor que no tiene datos porque a su CLI le falta la
 * status line (§6.37): el del plan y el de contexto.
 *
 * Hasta el 21-11-2026 era un `link-button`, texto suelto, y se perdia en la
 * fila. Pedido del usuario: que se vea como boton y que invite a configurarlo.
 * Es un `icon-button` mas de la fila, con los colores de siempre, y solo el
 * signo "!" va en el color de aviso.
 */

import { t } from './i18n/index.js';

interface MeterSetupButtonProps {
  onClick: () => void;
}

export function MeterSetupButton({ onClick }: MeterSetupButtonProps): JSX.Element {
  return (
    <button className="icon-button meter-setup-button" onClick={onClick}>
      <span className="meter-setup-mark" aria-hidden="true">
        !
      </span>
      {t('meter.configure')}
    </button>
  );
}
