/**
 * La fila de teclas de la vista CLI en pantalla angosta (hito 38, §6.25), y
 * desde el 25-09-2026 también de la Consola.
 *
 * El teclado de un teléfono no trae Esc, Tab ni flechas, y sin ellas una CLI
 * no se puede ni interrumpir. Cada botón manda por el mismo `input` que xterm
 * la secuencia que mandaría la tecla; la lista y las secuencias viven en
 * `narrow-layout.ts`, donde las prueba el chequeo.
 *
 * La CLI lleva una línea, con Enter primero; la Consola, dos que se deslizan
 * juntas (09-11-2026). Las dos líneas están dentro de una misma caja que se
 * desliza, y la más corta se estira hasta el ancho de la más larga: así quedan
 * alineadas al llegar al final.
 *
 * `preventDefault` en el `pointerdown`: si el botón tomara el foco, el teclado
 * en pantalla se cerraría y la terminal lo perdería con cada tecla.
 */

import { terminalKeyRows, type TerminalKeysKind } from './narrow-layout.js';
import { t } from './i18n/index.js';

interface TerminalKeysProps {
  /** Qué terminal se ve: la de la pestaña (CLI) o el shell de la Consola, que lleva más teclas. */
  kind: TerminalKeysKind;
  onKey: (data: string) => void;
}

export function TerminalKeys({ kind, onKey }: TerminalKeysProps): JSX.Element {
  return (
    <div className="narrow-keys" role="toolbar" aria-label={t('narrow.keys.label')}>
      <div className="narrow-keys-grid">
        {terminalKeyRows(kind).map((row, index) => (
          <div key={index} className="narrow-keys-line">
            {row.map((key) => (
              <button
                key={key.id}
                className={key.primary === true ? 'narrow-key narrow-key-primary' : 'narrow-key'}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onKey(key.data)}
                title={t(key.titleKey, key.titleParams)}
              >
                {key.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
