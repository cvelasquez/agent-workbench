/**
 * Lista de atajos.
 *
 * Por que una lista y no un editor de atajos: la app captura **cuatro**
 * combinaciones y ninguna mas. Todo lo demas —`Esc`, `Esc Esc`, `Ctrl+C`,
 * `Ctrl+R`, `Ctrl+O`, `Shift+Tab`, las flechas y sobre todo `Alt+V`, que es el
 * pegado de imagenes— tiene que llegar intacto a la CLI, y un remapeo libre es
 * la forma mas facil de robarle una tecla sin darse cuenta. Con cinco atajos, lo
 * que falta no es poder cambiarlos: es saber cuales son.
 *
 * Los `Ctrl+T`, `Ctrl+W` y `Ctrl+Tab` que pedia el brief **no existen en un
 * navegador**: Chrome se los queda para sus propias pestanas y el evento nunca
 * llega a la pagina. De ahi la familia `Alt`.
 *
 * `Alt + 1..9` estuvo y se saco: en Windows, Alt con el teclado numerico es
 * como se escriben los caracteres que no estan en el teclado (Alt+164 = ñ),
 * y capturarlo le rompe la escritura en espanol a quien usa un teclado en
 * ingles. Es el ejemplo exacto de por que la lista de atajos es corta.
 */

import { useEffect } from 'react';

interface Shortcut {
  keys: string;
  description: string;
}

const APP_SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Alt + T', description: 'Nueva pestaña en el directorio de la pestaña actual' },
  { keys: 'Alt + W', description: 'Cerrar la pestaña activa' },
  { keys: 'Alt + ← / →', description: 'Pestaña anterior / siguiente' },
  { keys: 'Alt + P', description: 'Mostrar u ocultar el panel derecho' },
  {
    keys: 'Shift + Tab',
    description: 'Volver a la pestaña anterior (fuera de la terminal: adentro es de la CLI)',
  },
];

/**
 * El cuadro de escritura tiene teclas propias, y son distintas de las de la
 * terminal a proposito: es otro widget. Que `Enter` envie y `Shift+Enter` salte
 * de linea solo es posible porque el texto viaja como un pegado.
 */
const COMPOSER_SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Enter', description: 'Enviar el mensaje' },
  { keys: 'Shift + Enter', description: 'Salto de línea sin enviar' },
  { keys: 'Ctrl + V', description: 'Pegar texto o una imagen (queda como miniatura)' },
  { keys: 'Esc', description: 'Interrumpir lo que la CLI esté haciendo' },
];

const CLI_SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Esc', description: 'Interrumpir lo que la CLI esté haciendo' },
  { keys: 'Esc Esc', description: 'Abrir el menú de rewind' },
  { keys: 'Ctrl + C', description: 'Cancelar' },
  { keys: 'Ctrl + R', description: 'Buscar en el historial de comandos' },
  { keys: 'Ctrl + O', description: 'Ver la salida completa' },
  { keys: 'Shift + Tab', description: 'Cambiar el modo de permisos (con el foco en la terminal)' },
  { keys: 'Alt + V', description: 'Pegar una imagen del portapapeles' },
  { keys: 'Ctrl + V', description: 'Pegar texto del portapapeles' },
];

interface ShortcutsDialogProps {
  onClose: () => void;
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Sin esto el Escape seguiria hasta xterm y ademas interrumpiria a la
        // CLI, que es justo lo que no se pidio al cerrar un dialogo.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label="Atajos de teclado"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">Atajos</span>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            ×
          </button>
        </header>

        <div className="modal-body">
          <h3 className="modal-section">De la aplicación</h3>
          <ShortcutList shortcuts={APP_SHORTCUTS} />

          <h3 className="modal-section">En el cuadro de escritura</h3>
          <ShortcutList shortcuts={COMPOSER_SHORTCUTS} />

          <h3 className="modal-section">De la CLI, dentro de la terminal</h3>
          <p className="modal-hint">
            Estas las maneja la CLI. La aplicación no las intercepta: le llegan tal cual. En la
            terminal, el salto de línea sigue siendo <kbd>Ctrl + J</kbd> y la imagen se pega con{' '}
            <kbd>Alt + V</kbd>; el cuadro de escritura es el que tiene las teclas de arriba.
          </p>
          <ShortcutList shortcuts={CLI_SHORTCUTS} />

          <p className="modal-hint">
            <strong>Ctrl+T</strong>, <strong>Ctrl+W</strong> y <strong>Ctrl+Tab</strong> no se
            pueden usar: el navegador se los queda para sus propias pestañas y el evento nunca
            llega a la página.
          </p>

          <p className="modal-hint">
            <strong>Alt + número</strong> tampoco se usa, y es a propósito: en Windows, Alt con
            el teclado numérico es como se escriben los caracteres que no están en el teclado
            (<kbd>Alt + 164</kbd> = ñ). Interceptarlo rompe la escritura en español. Para
            cambiar de pestaña están <kbd>Alt + ←</kbd> y <kbd>Alt + →</kbd>.
          </p>
        </div>
      </div>
    </div>
  );
}

function ShortcutList({ shortcuts }: { shortcuts: readonly Shortcut[] }): JSX.Element {
  return (
    <dl className="shortcut-list">
      {shortcuts.map((shortcut) => (
        <div className="shortcut-row" key={shortcut.keys}>
          <dt>
            <kbd>{shortcut.keys}</kbd>
          </dt>
          <dd>{shortcut.description}</dd>
        </div>
      ))}
    </dl>
  );
}
