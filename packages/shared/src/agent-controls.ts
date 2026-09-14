/**
 * Modelo y nivel de esfuerzo: lo que se puede elegir y como se reconoce.
 *
 * Dos ideas que sostienen todo este archivo:
 *
 *  - **Lo que se muestra es lo observado, no lo pedido.** El modelo y el
 *    esfuerzo que ve el usuario salen del archivo de sesion: `message.model` de
 *    la ultima linea `assistant` —con la variante resuelta por `cost-state`— y
 *    su campo `effort`. Si alguien cambia el modelo tecleando en la pestana CLI,
 *    el combo se entera igual; si la CLI rechaza lo que le pedimos, el combo no
 *    miente porque nunca guardo lo que pedimos.
 *  - **La lista es corta, explicita y puede quedar corta.** Los alias estan
 *    verificados contra la CLI 2.1.257, pero salen de una tabla y no de una API:
 *    si aparece un modelo nuevo, se agrega aca. Que la CLI rechace un valor no
 *    rompe nada — se ve en la pestana CLI y el combo se corrige solo en cuanto
 *    llega la siguiente linea del archivo.
 *
 * Y un detalle medido: **los niveles de esfuerzo dependen del modelo**. Con
 * haiku, `/effort low` no deja ni rastro en el archivo, porque ese modelo no
 * tiene niveles. Por eso el esfuerzo se ofrece siempre y se muestra vacio
 * cuando no hay ninguno observado, en vez de inventar un valor por defecto.
 */

export interface ModelOption {
  /** Lo que se le pasa a `/model`. */
  value: string;
  /** Nombre de la familia, sin la ventana. La etiqueta la arma `modelOptionLabel`. */
  label: string;
  /** Familia con la que casa lo que dice el archivo (`claude-opus-5`). */
  family: string;
  /** true si es la variante de ventana larga. */
  long: boolean;
  /**
   * Ventana de contexto de esta variante, o null si la elige la configuracion.
   *
   * Sale de la misma tabla que usa el medidor (`contextWindowFor`), y esta aca
   * para que la lista pueda decirla. La CLI solo nombra la variante larga
   * —en su binario aparecen `opus[1m]` y "1M context", nunca un "200K
   * context"—, con lo que la opcion corta quedaba sin ningun numero al lado y
   * la lista parecia traer el mismo modelo dos veces. No son dos modelos: es
   * uno con dos ventanas, y decir las dos es lo que lo aclara.
   */
  window: number | null;
}

/**
 * Lo que la configuracion dice que va a correr, antes de que corra.
 *
 * No es una observacion: es lo que el servidor leyo de los `settings.json` (ver
 * `agent-defaults.ts`). Sirve para que el combo no arranque vacio y lo pisa la
 * primera respuesta que aparezca en el archivo.
 */
export interface AgentDefaults {
  /** Alias tal como esta escrito en la configuracion (`opus`). */
  model: string | null;
  effort: string | null;
  /**
   * Ventana de contexto que le tocaria a ese modelo, o null si no la sabemos.
   *
   * La resuelve el servidor, no el cliente, y no se deduce del alias: la
   * configuracion guarda `opus` sin la variante (§4.5.1), asi que traducirlo
   * aca con una tabla daria 200k para una instalacion que corre en 1M — el
   * mismo error que el medidor tuvo una vez. Sale del historial, que si dice
   * con que variante trabaja esta instalacion; cuando no hay ninguna
   * observacion queda en null y el medidor dibuja la barra sin limite.
   */
  contextWindow: number | null;
}

/**
 * Modelos ofrecidos.
 *
 * `default` vuelve a lo que el usuario tenga configurado, sin que la aplicacion
 * tenga que elegir por el.
 */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { value: 'default', label: 'Por defecto', family: '', long: false, window: null },
  { value: 'opus', label: 'Opus', family: 'opus', long: false, window: 200_000 },
  { value: 'opus[1m]', label: 'Opus', family: 'opus', long: true, window: 1_000_000 },
  { value: 'sonnet', label: 'Sonnet', family: 'sonnet', long: false, window: 200_000 },
  { value: 'sonnet[1m]', label: 'Sonnet', family: 'sonnet', long: true, window: 1_000_000 },
  { value: 'haiku', label: 'Haiku', family: 'haiku', long: false, window: 200_000 },
  { value: 'fable', label: 'Fable', family: 'fable', long: false, window: 200_000 },
  { value: 'fable[1m]', label: 'Fable', family: 'fable', long: true, window: 1_000_000 },
];

/**
 * Como se lee una opcion en la lista: `Opus · 200k`, `Opus · 1M`.
 *
 * La ventana va en las dos, no solo en la larga. Con `Opus` a secas y
 * `Opus · 1M` debajo, la lista se lee como si trajera el mismo modelo repetido
 * y uno se pregunta si hay dos Opus 5 — pasó. Nombrar las dos ventanas
 * convierte la duda en la respuesta: es un modelo con dos tamaños de contexto.
 */
export function modelOptionLabel(option: ModelOption): string {
  if (option.window === null) return option.label;
  const window =
    option.window >= 1_000_000
      ? `${Math.round(option.window / 1_000_000)}M`
      : `${Math.round(option.window / 1_000)}k`;
  return `${option.label} · ${window}`;
}

/**
 * Niveles de esfuerzo.
 *
 * Los cinco salen de la propia CLI, que arma la lista segun el modelo: hay
 * modelos con cuatro y modelos con ninguno. Se ofrecen todos y manda la CLI.
 */
export const EFFORT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'low', label: 'Bajo' },
  { value: 'medium', label: 'Medio' },
  { value: 'high', label: 'Alto' },
  { value: 'xhigh', label: 'Muy alto' },
  { value: 'max', label: 'Maximo' },
];

/**
 * Que opcion del combo corresponde a lo que dice el archivo de sesion.
 *
 * Lo observado viene como `claude-opus-5` o `claude-opus-5[1m]`; las opciones
 * son alias (`opus`, `opus[1m]`). Se casa por familia y variante, que es lo
 * unico estable entre versiones: los sufijos de fecha cambian solos.
 *
 * Devuelve null si no se reconoce, y entonces el combo muestra el identificador
 * crudo. Se ha visto un `gpt-5.6-terra` en una sesion importada: la aplicacion
 * no puede depender de conocer todos los nombres.
 *
 * `options` es la lista de la CLI de la pestana (`capabilities.models`). Sin
 * ella, la de Claude Code, y el resultado es el de siempre.
 */
export function modelOptionFor(
  observed: string | null,
  options: readonly ModelOption[] = MODEL_OPTIONS,
): ModelOption | null {
  const family = modelFamilyOf(observed, options);
  if (family === null || observed === null) return null;
  const long = observed.includes('[1m]');
  return options.find((option) => option.family === family && option.long === long) ?? null;
}

/**
 * true si esa familia tiene una variante de ventana larga conocida.
 *
 * Sirve para saber cuando el nombre desnudo alcanza: haiku no ofrece `[1m]`,
 * asi que `claude-haiku-4-5` ya dice todo lo que hay que saber. Opus, sonnet y
 * fable si la tienen, y ahi el nombre sin sufijo no decide nada.
 */
export function familyHasLongVariant(family: string): boolean {
  return MODEL_OPTIONS.some((option) => option.family === family && option.long);
}

/**
 * Familia a la que pertenece un nombre de modelo, venga como venga.
 *
 * Casa igual un alias de la configuracion (`opus`, `opus[1m]`) que un id del
 * archivo de sesion (`claude-opus-5`). La familia es lo unico estable entre
 * versiones; los sufijos de fecha cambian solos.
 *
 * **Gana la familia mas larga contenida en el valor.** Con otra CLI una familia
 * puede ser parte de otra (`Gemini 3.1 Flash` y `Gemini 3.1 Flash Lite`), y en
 * el orden de la lista la corta se quedaria con la larga. Con las de Claude
 * Code ninguna contiene a otra, asi que el orden no cambia nada.
 */
export function modelFamilyOf(
  value: string | null,
  options: readonly ModelOption[] = MODEL_OPTIONS,
): string | null {
  if (value === null || value.length === 0) return null;
  // `sort` es estable: a igual largo manda el orden de la lista, como antes.
  const candidates = options
    .filter((option) => option.family.length > 0)
    .sort((a, b) => b.family.length - a.family.length);
  return candidates.find((option) => value.includes(option.family))?.family ?? null;
}

/** El comando que cambia el modelo. Se manda por el mismo camino que un mensaje. */
export function modelCommand(value: string): string {
  return `/model ${value}`;
}

export function effortCommand(value: string): string {
  return `/effort ${value}`;
}
