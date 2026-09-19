/**
 * El modo de permiso, a la izquierda de la barra del cuadro de escritura.
 *
 * Va del otro lado que el modelo y el esfuerzo, y no es un capricho de
 * simetria: es lo que decide **cuanto puede hacer el agente sin preguntar**, y
 * eso se mira antes de escribir el mensaje, no despues. Modelo y esfuerzo se
 * eligen una vez y se olvidan; el modo se cambia a mitad de una tarea —"pasá a
 * plan y proponeme algo antes de tocar nada"— y por eso queda donde empieza la
 * lectura.
 *
 * Sigue la misma regla que los otros dos (§5.4): **muestra lo observado, no lo
 * pedido.** Sale de las lineas `permission-mode` del archivo de sesion, asi que
 * si el usuario cicla con `shift+tab` en la solapa CLI el combo se entera por
 * el mismo camino.
 *
 * Lo que lo diferencia, y esta en el titulo del combo: la CLI **no tiene** un
 * comando para esto, solo `shift+tab`, que cicla. Cambiarlo desde aca son N
 * pulsaciones contadas por el servidor. Si alguien ciclo en la terminal y la
 * CLI todavia no escribio la linea que lo dice, la cuenta apunta a otro lado —
 * se ve en la solapa CLI, y el combo se corrige solo en cuanto el archivo
 * hable.
 */

import {
  isPermissionMode,
  type PermissionCycleCapability,
  type PermissionMode,
} from '@agent-workbench/shared';
import { modeChangeBlocked, modeControlTitle, modeLabel, shownMode } from './agent-ui.js';

interface ModeControlProps {
  /** Modo observado en el archivo, o null si todavia no lo dijo. */
  mode: PermissionMode | null;
  /**
   * El ciclo que declara la CLI de la pestana: los modos, en el orden en que
   * los recorre la tecla, y con cual se lanza. Es el mismo que usa el servidor
   * para contar pulsaciones (lo compara `check-agent-registry.mjs`).
   */
  cycle: PermissionCycleCapability;
  disabled: boolean;
  /**
   * Lo que la CLI esta esperando, segun su estado, o null. Con una CLI cuya
   * tecla de ciclo aprueba lo pendiente (hito 27) el combo se apaga mientras
   * espera: cambiar el modo ahi aprobaria algo que nadie leyo.
   */
  waitingFor?: string | null;
  /**
   * Si la app ve el estado de esta pestana (`blindToApprovals`, R27-1): no
   * alcanza con que su CLI lo publique. Sin eso, con una CLI cuya tecla aprueba
   * lo pendiente, el titulo avisa que la app no ve una confirmacion abierta.
   */
  statusKnown?: boolean;
  onChange: (mode: PermissionMode) => void;
}

export function ModeControl({
  mode,
  cycle,
  disabled,
  waitingFor = null,
  statusKnown = true,
  onChange,
}: ModeControlProps): JSX.Element {
  /*
    Sin observacion vale con que se lanzo la pestana, que lo pone la propia
    aplicacion (`--permission-mode auto`). No es una suposicion: es un
    argumento de la linea de comandos que escribimos nosotros. Por eso este
    combo no tiene un estado "sin datos" como el de modelo — ahi el dato es de
    la CLI y puede no existir, aca es nuestro.
  */
  const current = shownMode(mode, cycle);

  return (
    <select
      className="agent-select agent-select-mode"
      value={current}
      disabled={disabled || modeChangeBlocked(cycle, waitingFor)}
      onChange={(event) => {
        if (isPermissionMode(event.target.value)) onChange(event.target.value);
      }}
      title={modeControlTitle(current, cycle, statusKnown, waitingFor)}
    >
      {cycle.modes.map((entry) => (
        <option key={entry} value={entry}>
          {modeLabel(entry)}
        </option>
      ))}
    </select>
  );
}
