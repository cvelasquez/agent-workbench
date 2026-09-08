/**
 * Consolas del sistema, al pie de la columna derecha.
 *
 * Por que existen: en la terminal de la izquierda vive el agente, y meterle un
 * `git status` ahi significa interrumpir lo que este haciendo. Esto son pty
 * aparte, sin nada del agente adentro, para los comandos sueltos de siempre.
 *
 * Van debajo del panel y no como una cuarta solapa a proposito. Las tres
 * solapas se turnan porque compiten por el **ancho**, que es lo escaso; una
 * consola compite por el alto, y la gracia es justo poder mirar la lista de
 * cambios mientras se escribe abajo.
 *
 * Desde el hito 17 son **varias**, con solapas propias:
 *
 *  - **Todas viven en el mismo directorio**, el de la pestaña activa. No es una
 *    limitacion: es lo que hace que "Terminal 2" sirva para lo que uno la abre
 *    —dejar algo corriendo mientras usa la otra— sin tener que acordarse de
 *    donde quedo parada cada una.
 *  - **Ninguna se desmonta al cambiar de solapa**, igual que las pestañas del
 *    agente (CLAUDE.md 6): desmontarla soltaria el enganche y la repintaria
 *    entera con el replay. Se esconden con CSS y `TerminalView` deja de medir
 *    cuando su contenedor no tiene caja.
 *  - **Se numeran por posicion**, no por un nombre guardado. Una consola es
 *    desechable; ponerle nombre a algo que se abre y se cierra en un minuto es
 *    trabajo para el usuario a cambio de nada.
 *
 * Desde el hito 18 sus solapas y las de las notas son la **misma** familia de
 * CSS (`.strip-tab*`): eran identicas en intencion y distintas en todo lo
 * demas, y con dos hojas separadas tocar una y olvidar la otra era lo normal.
 *
 * Plegada no muere: queda la barra del pie, que la vuelve a mostrar. Cerrar de
 * verdad es la × de cada solapa, y eso si termina el proceso.
 */

import type { TerminalDescriptor, TerminalId } from '@agent-workbench/shared';
import { TerminalView } from './TerminalView.js';
import type { AgentConnection } from './connection.js';

interface ConsolePaneProps {
  connection: AgentConnection;
  /** Las consolas abiertas en este directorio, en orden de apertura. */
  shells: TerminalDescriptor[];
  activeShellId: TerminalId | null;
  /** Directorio donde se abren. Es el de la pestana activa. */
  cwd: string;
  /** Nombre de la consola del sistema, o null si el servidor no encontro ninguna. */
  shellName: string | null;
  theme: 'light' | 'dark';
  onSelect: (terminalId: TerminalId) => void;
  /** Abre una consola mas en el mismo directorio. */
  onOpen: () => void;
  /** Cierra una: termina el proceso. */
  onCloseShell: (terminalId: TerminalId) => void;
  /** Pliega el panel. No mata nada. */
  onCollapse: () => void;
}

export function ConsolePane({
  connection,
  shells,
  activeShellId,
  cwd,
  shellName,
  theme,
  onSelect,
  onOpen,
  onCloseShell,
  onCollapse,
}: ConsolePaneProps): JSX.Element {
  const label = shellName ?? 'Consola';
  const active = shells.find((shell) => shell.terminalId === activeShellId) ?? shells[0] ?? null;

  return (
    <section className="console-pane">
      <header className="console-header">
        <div className="strip-tabs">
          {shells.map((shell, index) => (
            <div
              key={shell.terminalId}
              className={`strip-tab${
                shell.terminalId === active?.terminalId ? ' is-active' : ''
              }${shell.alive ? '' : ' is-dead'}`}
            >
              <button
                className="strip-tab-label"
                onClick={() => onSelect(shell.terminalId)}
                title={
                  shell.alive
                    ? `${label} ${index + 1} en ${cwd}`
                    : `Terminada con codigo ${shell.exitCode ?? '?'}`
                }
              >
                Terminal {index + 1}
              </button>
              <button
                className="strip-tab-close"
                onClick={() => onCloseShell(shell.terminalId)}
                title="Cerrar esta terminal y terminar su proceso"
              >
                ×
              </button>
            </div>
          ))}

          {shellName !== null && (
            <button
              className="strip-tab-new"
              onClick={onOpen}
              title={`Abrir otra ${label} en ${cwd}`}
            >
              +
            </button>
          )}
        </div>

        <span className="strip-spacer" />
        <button
          className="icon-button"
          onClick={onCollapse}
          title="Plegar. Los procesos siguen vivos: para terminarlos, la × de cada terminal"
        >
          ▾
        </button>
      </header>

      <div className="console-body">
        {shells.length === 0 ? (
          <div className="console-empty">
            {shellName === null ? (
              <p className="panel-note">No se encontró ninguna consola del sistema para abrir.</p>
            ) : (
              <button className="link-button" onClick={onOpen}>
                Abrir {label} en {cwd}
              </button>
            )}
          </div>
        ) : (
          <div className="terminal-stack">
            {shells.map((shell) => (
              <TerminalView
                key={shell.terminalId}
                terminalId={shell.terminalId}
                connection={connection}
                active={shell.terminalId === active?.terminalId}
                theme={theme}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
