/**
 * Guardias del servidor local.
 *
 * Este servidor lanza procesos: si se expone, es ejecucion remota de codigo.
 * Todo lo que decide "quien puede hablarme" vive aca a proposito, para que la
 * revision de seguridad sea un solo archivo.
 *
 * Tres capas, todas obligatorias:
 *   1. bind solo a 127.0.0.1 (lo aplica index.ts al escuchar)
 *   2. token aleatorio por arranque, exigido en HTTP y en el upgrade del WS
 *   3. chequeo de Origin y Host, contra paginas maliciosas y DNS rebinding
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { TOKEN_QUERY_PARAM } from '@agent-workbench/shared';

/** Solo estas interfaces son validas. Nunca 0.0.0.0. */
export const LOOPBACK_HOST = '127.0.0.1';

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Header alternativo al query param, para clientes que no quieran ensuciar la URL. */
export const TOKEN_HEADER = 'x-agent-workbench-token';

/**
 * Cookie que se emite en la primera peticion autorizada por query.
 *
 * Por que existe: la URL que abre el navegador lleva el token, pero los assets
 * que pide despues (el bundle, /@vite/client, el HMR) no lo llevan. Sin la
 * cookie habria que dejar rutas sin token, y el brief exige que todas lo pidan.
 *
 * Limite conocido: las cookies ignoran el puerto, asi que otro servidor
 * escuchando en 127.0.0.1 puede recibirla. El token sigue siendo de un solo
 * arranque y el chequeo de Origin bloquea igual a una pagina de otro origen.
 */
export const TOKEN_COOKIE = 'agent_workbench_token';

/**
 * Token de un solo arranque. No se persiste en ningun lado: cerrar el servidor
 * lo invalida. 32 bytes de entropia real.
 */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Comparacion en tiempo constante. Evita filtrar el token byte por byte. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // timingSafeEqual exige longitudes iguales, y la longitud en si no es secreta.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Arma una URL absoluta a partir de una peticion, para poder leer el query. */
function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? LOOPBACK_HOST}`);
  } catch {
    return null;
  }
}

/** Lee una cookie del header sin traer una dependencia solo para esto. */
function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return null;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}

/** De donde salio el token aceptado. La cookie solo se emite si vino por URL. */
export type TokenSource = 'query' | 'header' | 'cookie';

export interface TokenMatch {
  source: TokenSource;
}

/**
 * Valida el token mirando query, header y cookie, en ese orden.
 * Devuelve null si ninguno coincide.
 */
export function matchToken(request: IncomingMessage, expected: string): TokenMatch | null {
  const url = requestUrl(request);
  const fromQuery = url?.searchParams.get(TOKEN_QUERY_PARAM) ?? null;
  if (fromQuery !== null && constantTimeEquals(fromQuery, expected)) {
    return { source: 'query' };
  }

  const fromHeader = request.headers[TOKEN_HEADER];
  if (typeof fromHeader === 'string' && constantTimeEquals(fromHeader, expected)) {
    return { source: 'header' };
  }

  const fromCookie = readCookie(request, TOKEN_COOKIE);
  if (fromCookie !== null && constantTimeEquals(fromCookie, expected)) {
    return { source: 'cookie' };
  }

  return null;
}

export function hasValidToken(request: IncomingMessage, expected: string): boolean {
  return matchToken(request, expected) !== null;
}

/**
 * Cookie de sesion: sin Max-Age, muere al cerrar el navegador.
 * SameSite=Strict para que no viaje en peticiones originadas por otro sitio.
 */
export function buildTokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

/**
 * El Host debe ser loopback.
 *
 * Sin esto, un atacante puede apuntar un dominio propio a 127.0.0.1 (DNS
 * rebinding) y el navegador nos hablaria creyendo que somos ese dominio.
 */
export function hasValidHost(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  if (typeof host !== 'string') return false;

  const separator = host.lastIndexOf(':');
  const hostname = separator === -1 ? host : host.slice(0, separator);
  const hostPort = separator === -1 ? '' : host.slice(separator + 1);

  if (!ALLOWED_HOSTNAMES.has(hostname)) return false;
  return hostPort === '' || hostPort === String(port);
}

/**
 * El Origin, si viene, debe ser el nuestro.
 *
 * Un Origin ausente se acepta: las navegaciones de primer nivel no lo mandan, y
 * tampoco lo manda un cliente que no sea un navegador. La proteccion real ahi
 * la da el token. Una pagina maliciosa corriendo en el navegador del usuario,
 * en cambio, SIEMPRE manda Origin, y es exactamente a quien queremos frenar.
 */
export function hasValidOrigin(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) return false;
  return parsed.port === String(port);
}

export type RejectionReason = 'bad-host' | 'bad-origin' | 'bad-token';

/**
 * Chequeo unico que aplican tanto las rutas HTTP como el upgrade del WebSocket.
 * Devuelve null si la peticion es aceptable.
 */
export function rejectRequest(
  request: IncomingMessage,
  port: number,
  token: string,
): RejectionReason | null {
  if (!hasValidHost(request, port)) return 'bad-host';
  if (!hasValidOrigin(request, port)) return 'bad-origin';
  if (!hasValidToken(request, token)) return 'bad-token';
  return null;
}
