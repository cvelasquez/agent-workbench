/**
 * Modelo y esfuerzo, al lado del boton de enviar.
 *
 * Es el ejemplo mas claro de para que existe la separacion entre la
 * conversacion y la pestana CLI: cambiar el modelo es una orden a la
 * herramienta, no algo que uno le dice al agente. Se elige aca y **se ve en la
 * pestana CLI**, sin ensuciar el hilo de la conversacion. Era el pedido
 * textual: "mantenerme enfocado en mi trabajo, no en las instrucciones de barra
 * effort o cosas asi".
 *
 * Lo que muestran los combos sale del archivo de sesion, no de lo que elegimos:
 *
 *  - el modelo, de `message.model` de la ultima respuesta, con la variante ya
 *    resuelta por el medidor de contexto;
 *  - el esfuerzo, del campo `effort` de esa misma linea.
 *
 * Por eso funciona igual si el usuario cambia el modelo tecleando en la
 * terminal, y por eso no hay forma de que el combo diga una cosa y la CLI este
 * usando otra.
 *
 * Mientras no haya ninguna respuesta el archivo no dice nada, y ahi entra un
 * valor **provisional** leido de la configuracion (`agent-defaults.ts`): es de
 * donde la CLI saca el banner que el usuario esta viendo al lado. Se distingue
 * en el titulo —"segun tu configuracion" -- para no hacerlo pasar por
 * observado, y lo pisa la primera respuesta que llegue.
 */

import {
  effortCommand,
  modelCommand,
  modelOptionLabel,
  type EffortOption,
  type ModelOption,
} from '@agent-workbench/shared';
import { modelOptionIn } from './agent-ui.js';
import { t, type MessageKey } from './i18n/index.js';

/**
 * Los niveles de esfuerzo conocidos, en el idioma de la app. La CLI manda los
 * suyos con una etiqueta en espanol (`EFFORT_OPTIONS`); uno que esta tabla no
 * conoce se muestra con esa etiqueta.
 */
const EFFORT_KEYS: Readonly<Record<string, MessageKey>> = {
  low: 'controls.effort.low',
  medium: 'controls.effort.medium',
  high: 'controls.effort.high',
  xhigh: 'controls.effort.xhigh',
  max: 'controls.effort.max',
};

function effortLabel(entry: EffortOption): string {
  const key = EFFORT_KEYS[entry.value];
  return key === undefined ? entry.label : t(key);
}

/** "Por defecto" es la unica opcion de modelo que no es un nombre propio. */
function modelLabel(entry: ModelOption): string {
  return entry.value === 'default' ? t('controls.model.default') : modelOptionLabel(entry);
}

interface AgentControlsProps {
  /**
   * Modelos que acepta el comando de la CLI de la pestana, o null si no lo
   * tiene: ahi el combo no se dibuja. Salen de sus capacidades y no de una
   * tabla fija, porque otra CLI acepta el mismo comando con otros nombres.
   */
  models: readonly ModelOption[] | null;
  /** Niveles de esfuerzo, con el mismo criterio. */
  efforts: readonly EffortOption[] | null;
  /** Modelo a mostrar: observado en el archivo, o el de la configuracion. */
  model: string | null;
  /** Esfuerzo a mostrar, con el mismo criterio. */
  effort: string | null;
  /** true si el modelo sale de la configuracion y no de una respuesta real. */
  modelProvisional?: boolean;
  effortProvisional?: boolean;
  /**
   * true con la CLI que guarda lo elegido como predeterminado (`savesModelChoiceFor`):
   * el titulo lo dice.
   */
  savesChoice?: boolean;
  disabled: boolean;
  /** Manda el comando por el mismo camino que un mensaje del cuadro. */
  onCommand: (command: string) => void;
}

export function AgentControls({
  models,
  efforts,
  model,
  effort,
  modelProvisional = false,
  effortProvisional = false,
  savesChoice = false,
  disabled,
  onCommand,
}: AgentControlsProps): JSX.Element {
  const option = models === null ? null : modelOptionIn(models, model);
  // Un modelo que no esta en la tabla igual se muestra, con su nombre crudo:
  // se vio un `gpt-5.6-terra` en una sesion importada.
  const unknown = option === null && model !== null;

  return (
    <>
      {models !== null && (
        <select
          className="agent-select"
          value={option?.value ?? ''}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value.length > 0) onCommand(modelCommand(event.target.value));
          }}
          title={
            model === null
              ? t('controls.model.noData')
              : modelProvisional
                ? t('controls.model.provisional', { model })
                : savesChoice
                  ? t('controls.model.inUseSaved', { model })
                  : t('controls.model.inUse', { model })
          }
          /*
            Cada familia aparece dos veces porque son dos ventanas de contexto del
            mismo modelo, no dos modelos. Es la misma eleccion que ofrece la CLI
            con `/model opus[1m]`.
          */
        >
          {option === null && (
            <option value="">{unknown ? (model ?? '') : t('controls.model.placeholder')}</option>
          )}
          {models.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {modelLabel(entry)}
            </option>
          ))}
        </select>
      )}

      {efforts !== null && (
        <select
          className="agent-select"
          value={effort ?? ''}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value.length > 0) onCommand(effortCommand(event.target.value));
          }}
          title={
            effort === null
              ? t('controls.effort.noData')
              : effortProvisional
                ? t('controls.effort.provisional', { effort })
                : savesChoice
                  ? t('controls.effort.inUseSaved', { effort })
                  : t('controls.effort.inUse', { effort })
          }
        >
          {effort === null && <option value="">{t('controls.effort.placeholder')}</option>}
          {efforts.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {effortLabel(entry)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
