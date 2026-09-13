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
              ? 'Modelo: todavia no hubo ninguna respuesta en esta sesion'
              : modelProvisional
                ? `Modelo segun tu configuracion: ${model}. Todavia no hubo ninguna respuesta que lo confirme`
                : `Modelo en uso: ${model}. Cambiarlo manda /model a la pestaña CLI`
          }
          /*
            Cada familia aparece dos veces porque son dos ventanas de contexto del
            mismo modelo, no dos modelos. Es la misma eleccion que ofrece la CLI
            con `/model opus[1m]`.
          */
        >
          {option === null && (
            <option value="">{unknown ? (model ?? '') : 'modelo — sin datos'}</option>
          )}
          {models.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {modelOptionLabel(entry)}
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
              ? 'Esfuerzo: sin datos. No todos los modelos tienen niveles — con haiku, /effort no deja rastro'
              : effortProvisional
                ? `Esfuerzo segun tu configuracion: ${effort}. Todavia no hubo ninguna respuesta que lo confirme`
                : `Esfuerzo en uso: ${effort}. Cambiarlo manda /effort a la pestaña CLI`
          }
        >
          {effort === null && <option value="">esfuerzo — sin datos</option>}
          {efforts.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
