/**
 * Que variante de cada modelo usa esta instalacion.
 *
 * Existe por un hecho medido, no por una sospecha: **las lineas `assistant` del
 * JSONL guardan el modelo sin su sufijo de variante.** En el historial de esta
 * maquina, `message.model` dice `claude-opus-5` en todas las sesiones, tanto en
 * las que corren con 200k como en las que corren con 1M. Las claves de
 * `modelUsage` de las lineas `cost-state`, en cambio, si traen el id completo:
 * `claude-opus-5[1m]`.
 *
 * De ahi que el medidor mostrara 200k para una sesion de 1M: leia el unico
 * campo que nunca lo dice.
 *
 * El problema de usar `cost-state` como fuente unica es que llega tarde y a
 * veces no llega: medido sobre las 10 sesiones mas recientes, falta en 2, y
 * cuando esta aparece cerca del final (linea 614 de 671, 1383 de 1386). Una
 * sesion recien abierta no tiene ninguna. Por eso el dato no se busca por
 * sesion sino por **instalacion**: lo que el usuario tiene configurado hoy vale
 * para la pestana que abra dentro de un minuto, y el historial ya lo dice.
 *
 * Quien lo alimenta:
 *  - `session-index`, que ya lee la cola de cada archivo del historial para los
 *    titulos. `cost-state` vive justo ahi, asi que no cuesta una lectura mas.
 *  - `conversation-follower`, con lo que ve en vivo en la sesion que sigue.
 *
 * Gana la observacion **mas reciente**, no la de ventana mas grande. Si alguien
 * uso 1M en marzo y volvio a 200k, lo cierto es 200k, y quedarse con el maximo
 * historico seria dibujar una barra optimista para siempre.
 */

import {
  contextWindowFor,
  familyHasLongVariant,
  modelFamilyOf,
  modelVariantBase,
} from '@agent-workbench/shared';

/** true si el id trae sufijo de variante (`claude-opus-5[1m]`). */
function declaresVariant(fullId: string): boolean {
  return fullId !== modelVariantBase(fullId);
}

interface Observation {
  /** Id completo tal como lo escribio la CLI, con sufijo si lo tenia. */
  fullId: string;
  /** Cuando se vio. Epoch ms; para una sesion en vivo, el momento de leerla. */
  at: number;
}

export class ModelVariantRegistry {
  private readonly byBase = new Map<string, Observation>();

  /**
   * Lo mismo, pero **solo con los ids que declaran variante**.
   *
   * Medido hoy sobre este historial, y contradice lo que decia §4.5.1: los dos
   * `cost-state` mas recientes traen `claude-opus-5` a secas, sin ningun
   * `claude-opus-5[1m]` al lado, en una instalacion que corre en 1M — la
   * sesion abierta va por 255k. O sea que el id desnudo **si** aparece solo, y
   * por lo tanto no significa "200k": significa "esta linea no dice la
   * variante". Como llega mas nuevo, pisaba al bueno y el medidor de una
   * pestana recien abierta anunciaba 200k en una instalacion de 1M.
   *
   * `resolve()` sigue mirando todas las observaciones —ahi el orden temporal es
   * lo unico que puede reflejar un cambio de variante, y el error lo corrige
   * `fitWindowToObserved` en cuanto los tokens no entran—. Esto es para la otra
   * pregunta, la del medidor **antes** de la primera respuesta, donde no hay
   * tokens medidos que sirvan de red y una barra equivocada no se corrige sola.
   *
   * Lo que se paga: si alguien vuelve de 1M a 200k, la barra inicial va a
   * seguir diciendo 1M hasta la primera respuesta, que la corrige. Es un error
   * que dura un turno; el otro duraba toda la sesion.
   */
  private readonly byVariant = new Map<string, Observation>();

  /**
   * Registra un id completo visto en un `cost-state`.
   *
   * `at` es el mtime del archivo cuando viene del historial. Sin el, dos
   * sesiones viejas se pisarian en el orden arbitrario del recorrido del
   * directorio.
   */
  observe(fullId: string, at: number): void {
    if (fullId.length === 0) return;
    const base = modelVariantBase(fullId);

    /*
      `byVariant` se actualiza PRIMERO y con su propia regla.

      Los `return` de mas abajo son de `byBase`, que descarta lo viejo. Si esta
      actualizacion viviera despues de ellos, un `claude-opus-5[1m]` con mtime
      anterior al de un desnudo ya registrado se perderia entero — y como los
      archivos del historial se recorren por directorio y no por fecha, ese
      orden es el habitual, no el raro. Sintoma medido: `windowForConfigured`
      devolvia null y la barra de una pestana nueva salia sin limite en una
      instalacion que tiene `[1m]` por todo el historial.
    */
    if (declaresVariant(fullId)) {
      const known = this.byVariant.get(base);
      if (known === undefined || known.at <= at) this.byVariant.set(base, { fullId, at });
    }

    const previous = this.byBase.get(base);
    if (previous !== undefined) {
      if (previous.at > at) return;
      /*
        A igualdad de tiempo gana el id que **declara** variante.

        Un mismo `cost-state` puede traer la misma base dos veces, con sufijo y
        sin el: medido en esta instalacion, `claude-opus-5[1m]` y
        `claude-opus-5` en la misma linea, y el desnudo **siempre segundo**. Las
        dos claves entran con el mtime del archivo, asi que sin este desempate
        el desnudo pisa al bueno por puro orden de recorrido y el medidor
        vuelve a dibujar 200k en una sesion de 1M — el sintoma exacto que este
        modulo existe para evitar.

        El desnudo no es evidencia de que la instalacion volvio a 200k: sobre
        250 archivos, aparece solo 0 veces. Siempre acompana a uno con sufijo.
        Por eso no aporta y no puede desplazar al que si aporta.
      */
      if (previous.at === at && declaresVariant(previous.fullId) && !declaresVariant(fullId)) {
        return;
      }
    }
    this.byBase.set(base, { fullId, at });
  }

  /** Todas las claves de `modelUsage` de una linea `cost-state`. */
  observeCostState(record: Record<string, unknown>, at: number): void {
    const modelUsage = record['modelUsage'];
    if (typeof modelUsage !== 'object' || modelUsage === null) return;
    for (const fullId of Object.keys(modelUsage)) this.observe(fullId, at);
  }

  /**
   * Id completo para un modelo que vino sin sufijo.
   *
   * Si no sabemos nada de el, se devuelve tal cual: el resto de la cadena ya
   * sabe tratar un modelo desconocido, y una variante inventada seria peor que
   * no saber.
   */
  resolve(model: string | null): string | null {
    if (model === null || model.length === 0) return model;
    // Un id que ya trae variante manda sobre lo que sepamos de la instalacion.
    if (model !== modelVariantBase(model)) return model;
    return this.byBase.get(model)?.fullId ?? model;
  }

  /**
   * Ventana que le corresponde al modelo que anuncia la configuracion.
   *
   * Es la misma pregunta que resuelve `resolve()`, pero desde el otro lado: ahi
   * llega un id del archivo de sesion, aca un alias de `settings.json`
   * (`opus`). Y el alias tiene el mismo agujero que la linea `assistant` — no
   * dice la variante—, asi que pasarlo por la tabla de ventanas daria 200k en
   * una instalacion que corre en 1M.
   *
   * Por eso mira `byVariant` y no `byBase`: antes de la primera respuesta no
   * hay tokens medidos que corrijan una ventana equivocada, y un id desnudo no
   * dice "200k" sino "esta linea no declara la variante". Sin ninguna
   * observacion util queda lo que diga la tabla, que para un alias corto es
   * null: el medidor dibuja la barra sin limite antes que inventar uno.
   */
  windowForConfigured(alias: string | null): number | null {
    if (alias === null || alias.length === 0) return null;
    // Un alias que ya declara variante manda: es una eleccion explicita.
    if (declaresVariant(alias)) return contextWindowFor(alias);

    const family = modelFamilyOf(alias);
    if (family === null) return null;

    /*
      Una familia sin variante larga no tiene nada que averiguar: haiku no
      ofrece `[1m]`, asi que su nombre desnudo ya dice todo lo que hay. Ahi
      cualquier observacion sirve; en las demas, solo una que declare.
    */
    const source = familyHasLongVariant(family) ? this.byVariant : this.byBase;

    let best: Observation | null = null;
    for (const [base, observation] of source) {
      if (!base.includes(family)) continue;
      if (best === null || observation.at > best.at) best = observation;
    }
    return best === null ? null : contextWindowFor(best.fullId);
  }

  /** Solo para diagnostico y para el chequeo. */
  snapshot(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [base, observation] of this.byBase) result[base] = observation.fullId;
    return result;
  }
}
