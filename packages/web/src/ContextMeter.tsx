/**
 * Medidor de contexto.
 *
 * Dos reglas que valen mas que cualquier detalle de presentacion:
 *
 *  1. **Tokens, nunca dinero.** El JSONL trae `totalCostUSD` en las lineas
 *     `cost-state` y se ignora a proposito: los precios cambian y una cifra
 *     desactualizada es peor que ninguna.
 *  2. **Si no reconocemos el modelo, no hay barra.** Se vio `gpt-5.6-terra` en
 *     una sesion importada, con la propia CLI avisando que no lo conocia.
 *     Mostrar los tokens contra un limite inventado seria mentir con precision.
 *  3. **Antes de la primera respuesta no se muestra un cero.** Una sesion
 *     recien abierta no arranca vacia: el prompt de sistema, las herramientas y
 *     el CLAUDE.md del proyecto ya estan adentro, y la primera peticion reporta
 *     decenas de miles de tokens. Una barra en cero afirmaria que la ventana
 *     esta libre, que es la misma clase de mentira que la regla 2. Se dibuja el
 *     hueco de la barra, vacio, y la palabra "sin medir" donde va el numero:
 *     asi el medidor no aparece de la nada al llegar la primera respuesta ni
 *     promete un dato que no tiene.
 *  4. **Se dice de donde sale el limite.** El nombre del modelo que guarda el
 *     JSONL viene sin el sufijo de variante, asi que el limite se reconstruye
 *     (ver `model-variants.ts`). Cuando ademas hubo que deducirlo de los tokens
 *     medidos, se marca: una cota inferior no es un dato publicado, y
 *     presentarla como tal es la misma mentira de la regla 2 con otra ropa.
 */

import type { ContextUsage } from '@agent-workbench/shared';

/** Umbrales de color. Son de presentacion: la CLI no publica ninguno. */
const WARN_RATIO = 0.75;
const DANGER_RATIO = 0.9;

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  return `${(value / 1_000_000).toFixed(2)}M`;
}

interface ContextMeterProps {
  usage: ContextUsage;
  /**
   * Ventana que anuncia la configuracion, para el rato en que la sesion todavia
   * no midio nada. Solo se usa en ese estado: en cuanto hay una respuesta manda
   * lo observado, que es lo que de verdad corrio.
   */
  fallbackWindow?: number | null;
  /**
   * Version de una sola linea, para la barra de busqueda.
   *
   * Es el mismo dato y los mismos umbrales; lo unico que cambia es que el
   * detalle de la sesion se va al titulo en vez de ocupar dos filas. El medidor
   * dejo de vivir en un pie propio y comparte fila con el buscador: apilado ahi
   * empujaria la conversacion tres lineas hacia abajo.
   */
  compact?: boolean;
}

export function ContextMeter({
  usage,
  fallbackWindow = null,
  compact = false,
}: ContextMeterProps): JSX.Element {
  const { lastRequestTokens, contextWindow } = usage;

  if (usage.assistantMessages === 0) {
    /*
      El hueco de la barra se dibuja siempre, con ventana o sin ella: aca esta
      vacio por definicion y no hay nada que malinterpretar, y reservar el sitio
      es justamente lo que evita que la fila se reacomode sola cuando llega la
      primera respuesta. El limite, en cambio, solo aparece si el usuario lo
      declaro: un `opus` a secas no dice si son 200k o 1M (ver
      `agent-defaults.ts`), y anunciar 200k en una sesion de 1M seria la misma
      mentira de la regla 2 con otra ropa.
    */
    const detail =
      'La sesion todavia no midio ninguna respuesta. No arranca en cero: el prompt de' +
      ' sistema, las herramientas y el CLAUDE.md ya ocupan contexto, y el numero real' +
      ' aparece con la primera respuesta.';

    return (
      <div className={`meter meter-idle${compact ? ' meter-compact' : ''}`} title={detail}>
        <span className="meter-label">Contexto</span>
        <span className={`meter-bar${compact ? ' meter-bar-inline' : ''}`} />
        <span className="meter-value">
          sin medir
          {fallbackWindow !== null && (
            <span className="meter-dim"> / {formatTokens(fallbackWindow)}</span>
          )}
        </span>
      </div>
    );
  }

  const ratio = contextWindow !== null && contextWindow > 0
    ? Math.min(lastRequestTokens / contextWindow, 1)
    : null;

  const level =
    ratio === null ? 'unknown' : ratio >= DANGER_RATIO ? 'danger' : ratio >= WARN_RATIO ? 'warn' : 'ok';

  const window =
    contextWindow === null
      ? ''
      : ` / ${formatTokens(contextWindow)}${usage.contextWindowEstimated ? '+' : ''}`;

  if (compact) {
    /*
      Todo lo que en la version apilada son filas aparte vive aca en el titulo.
      Se pierde de un vistazo y se gana al pasar el mouse; en una fila de 26 px
      no hay sitio para las dos cosas.
    */
    const detail = [
      usage.lastModel === null ? null : usage.lastModel,
      usage.contextWindowEstimated ? 'limite deducido de los tokens medidos' : null,
      ratio === null ? 'modelo no reconocido: sin tamano de ventana' : `${Math.round(ratio * 100)}% de la ventana`,
      `salida ${formatTokens(usage.lastOutputTokens)}`,
      `sesion ${formatTokens(usage.totalOutputTokens)} out · ${formatTokens(
        usage.totalCacheReadTokens,
      )} cache · ${usage.assistantMessages} resp.`,
    ]
      .filter((piece): piece is string => piece !== null)
      .join(' · ');

    return (
      <div className="meter meter-compact" title={detail}>
        <span className="meter-label">Contexto</span>
        {ratio !== null && (
          <span className="meter-bar meter-bar-inline">
            <span
              className={`meter-fill meter-fill-${level}`}
              style={{ width: `${ratio * 100}%` }}
            />
          </span>
        )}
        <span className="meter-value">
          {formatTokens(lastRequestTokens)}
          {window.length > 0 && <span className="meter-dim">{window}</span>}
        </span>
      </div>
    );
  }

  return (
    <div className="meter">
      <div className="meter-row">
        <span className="meter-label">Contexto</span>
        <span className="meter-value">
          {formatTokens(lastRequestTokens)}
          {contextWindow !== null && (
            <span
              className="meter-dim"
              /*
                El titulo lleva el modelo **ya resuelto**, con su variante. Es
                justo el dato que faltaba cuando el medidor decia 200k en una
                sesion de 1M, asi que si el numero vuelve a verse raro, la
                respuesta esta a un hover de distancia.
              */
              title={
                usage.lastModel === null
                  ? undefined
                  : usage.contextWindowEstimated
                    ? `${usage.lastModel} — limite deducido de los tokens medidos`
                    : usage.lastModel
              }
            >
              {' '}
              / {formatTokens(contextWindow)}
              {usage.contextWindowEstimated && '+'}
            </span>
          )}
        </span>
      </div>

      {ratio !== null ? (
        <div className="meter-bar" title={`${Math.round(ratio * 100)}% de la ventana`}>
          <div className={`meter-fill meter-fill-${level}`} style={{ width: `${ratio * 100}%` }} />
        </div>
      ) : (
        /*
          Sin ventana conocida no hay barra que dibujar, y se dice por que.
          Silenciarlo dejaria al usuario pensando que el medidor esta roto.
        */
        <div className="meter-note" title={usage.lastModel ?? undefined}>
          modelo no reconocido: se muestran los tokens, no el tamano de la ventana
        </div>
      )}

      <div className="meter-row meter-row-dim">
        <span title="Ultima respuesta del modelo">
          salida {formatTokens(usage.lastOutputTokens)}
        </span>
        <span title="Acumulado de toda la sesion">
          sesion {formatTokens(usage.totalOutputTokens)} out ·{' '}
          {formatTokens(usage.totalCacheReadTokens)} cache · {usage.assistantMessages} resp.
        </span>
      </div>
    </div>
  );
}
