/**
 * Estrechadores para lo que llega por la red.
 *
 * Todo mensaje entrante es `unknown` hasta que pasa por aca. Nada de castear:
 * un mensaje mal formado tiene que devolver null, no reventar mas adelante con
 * un `undefined` donde se esperaba un string.
 */

/** Objeto plano cuyas claves aun no fueron validadas. */
export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** String con contenido. Un id vacio es tan invalido como uno ausente. */
export function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Numero finito. Filtra NaN e Infinity, que se cuelan por JSON como null. */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Entero mayor que cero. Las dimensiones del pty no admiten otra cosa. */
export function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    result.push(item);
  }
  return result;
}

/** Mapea un array validando cada elemento; si uno falla, falla todo. */
export function asArrayOf<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const item of value) {
    const parsed = parseItem(item);
    if (parsed === null) return null;
    result.push(parsed);
  }
  return result;
}

/**
 * Mapea un array descartando los elementos que no pasan, en vez de fallar todo.
 *
 * Es para las listas donde un elemento que este lado no entiende no invalida a
 * los demas: un servidor mas nuevo que nombra una CLI que este cliente no
 * conoce no puede dejarlo sin la lista entera. `asArrayOf` sigue siendo la
 * regla por defecto; esta se elige a proposito, lista por lista.
 *
 * Devuelve null solo si `value` no es un array.
 */
export function asArrayFiltered<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const result: T[] = [];
  for (const item of value) {
    const parsed = parseItem(item);
    if (parsed !== null) result.push(parsed);
  }
  return result;
}

/** Estrecha a uno de los valores permitidos, o null. */
export function asLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
