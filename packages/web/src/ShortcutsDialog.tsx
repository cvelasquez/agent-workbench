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
import type { AgentInfo } from '@agent-workbench/shared';
import { AGENT_UI, composerShortcuts, type Shortcut } from './agent-ui.js';
import { t } from './i18n/index.js';
import { tRich } from './i18n/rich.js';

/** Los atajos de la app. Una funcion y no una constante: se traducen al leerlos. */
function appShortcuts(): readonly Shortcut[] {
  return [
    { keys: 'Alt + T', description: t('shortcuts.app.newTab') },
    { keys: 'Alt + W', description: t('shortcuts.app.closeTab') },
    { keys: 'Alt + ← / →', description: t('shortcuts.app.switchTab') },
    { keys: 'Alt + P', description: t('shortcuts.app.togglePanel') },
    { keys: 'Shift + Tab', description: t('shortcuts.app.previousTab') },
  ];
}

/*
  Las teclas del cuadro de escritura salen de `composerShortcuts` y las de la
  CLI de `AGENT_UI` (`agent-ui.ts`): dependen de la CLI de la pestana, y ahi
  las compara el chequeo con las de siempre.

  El cuadro tiene teclas propias, y son distintas de las de la terminal a
  proposito: es otro widget. Que `Enter` envie y `Shift+Enter` salte de linea
  solo es posible porque el texto viaja como un pegado.
*/

interface ShortcutsDialogProps {
  /**
   * La CLI de la que habla el dialogo (`shortcutsAgent`): la de la pestana
   * activa, o la que se usaria para abrir una. null solo antes del `hello`, y
   * ahi no se dibuja la seccion de la terminal: no hay de quien hablar.
   */
  agent: AgentInfo | null;
  onClose: () => void;
}

export function ShortcutsDialog({ agent, onClose }: ShortcutsDialogProps): JSX.Element {
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
        aria-label={t('shortcuts.ariaLabel')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">{t('shortcuts.title')}</span>
          <button className="icon-button" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <h3 className="modal-section">{t('shortcuts.section.app')}</h3>
          <ShortcutList shortcuts={appShortcuts()} />

          <h3 className="modal-section">{t('shortcuts.section.composer')}</h3>
          <ShortcutList
            shortcuts={composerShortcuts(agent !== null && agent.capabilities.imagesByPath !== null)}
          />

          {agent !== null && (
            <>
              <h3 className="modal-section">{t('shortcuts.section.cli')}</h3>
              <p className="modal-hint">{tRich('shortcuts.cliHint')}</p>
              <ShortcutList shortcuts={AGENT_UI[agent.id].shortcuts} />
              {/* Las teclas que la CLI tiene y que aca no le llegan. */}
              {AGENT_UI[agent.id].shortcutsNote !== null && (
                <p className="modal-hint">{AGENT_UI[agent.id].shortcutsNote}</p>
              )}
            </>
          )}

          <p className="modal-hint">{tRich('shortcuts.browserReserved')}</p>

          <p className="modal-hint">{tRich('shortcuts.altNumber')}</p>
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
