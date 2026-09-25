/**
 * La fila de teclas de la vista CLI en pantalla angosta (hito 38, §6.25), y
 * desde el 25-09-2026 también de la Consola.
 *
 * El teclado de un teléfono no trae Esc, Tab ni flechas, y sin ellas una CLI
 * no se puede ni interrumpir. Cada botón manda por el mismo `input` que xterm
 * la secuencia que mandaría la tecla; la lista y las secuencias viven en
 * `narrow-layout.ts`, donde las prueba el chequeo.
 *
 * `preventDefault` en el `pointerdown`: si el botón tomara el foco, el teclado
 * en pantalla se cerraría y la terminal lo perdería con cada tecla.
 */

import { TERMINAL_KEYS } from './narrow-layout.js';
import { t } from './i18n/index.js';

interface TerminalKeysProps {
  onKey: (data: string) => void;
}

export function TerminalKeys({ onKey }: TerminalKeysProps): JSX.Element {
  return (
    <div className="narrow-keys" role="toolbar" aria-label={t('narrow.keys.label')}>
      {TERMINAL_KEYS.map((key) => (
        <button
          key={key.id}
          className="narrow-key"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onKey(key.data)}
          title={t(key.titleKey)}
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}
