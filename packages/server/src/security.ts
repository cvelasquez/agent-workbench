/**
 * Guardias del servidor local.
 *
 * Este servidor lanza procesos: si se expone, es ejecucion remota de codigo.
 * Todo lo que decide "quien puede hablarme" vive aca a proposito, para que la
 * revision de seguridad sea un solo archivo.
 *
 * Tres capas, todas obligatorias:
 *   1. bind solo a 127.0.0.1 (lo aplica index.ts al escuchar)
 *   2. una credencial, exigida en HTTP y en el upgrade del WS: el token
 *      aleatorio de este arranque o, con el acceso remoto encendido, la de un
 *      equipo emparejado
 *   3. chequeo de Origin y Host, contra paginas maliciosas y DNS rebinding
 *
 * El acceso remoto (hito 37, CLAUDE.md 14) no afloja ninguna: el otro equipo
 * llega por un tunel SSH, asi que la conexion sigue entrando por 127.0.0.1 y con
 * `Host` y `Origin` de loopback. Lo unico que suma es la segunda credencial de
 * la capa 2, que no cambia en cada arranque porque desde el otro equipo no se ve
 * la consola de este.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PAIR_QUERY_PARAM, TOKEN_QUERY_PARAM } from '@agent-workbench/shared';
import type { DeviceVerifier } from './remote-access.js';

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

/**
 * Cookie de sesion: sin Max-Age, muere al cerrar el navegador.
 * SameSite=Strict para que no viaje en peticiones originadas por otro sitio.
 */
export function buildTokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

/**
 * Cookie de un equipo emparejado (hito 37). Al reves que la de sesion, dura:
 * el otro equipo tiene que poder volver manana, con esta app reiniciada.
 *
 * Tiene el mismo limite conocido que `TOKEN_COOKIE`, y aca pesa mas porque no
 * muere con el arranque: las cookies ignoran el puerto, asi que otro servidor
 * que escuche en el `localhost` **del otro equipo** la recibe. Por eso un
 * equipo se puede revocar, y por eso no sirve para emparejar otros
 * (`remoteRefusal`).
 *
 * Sin `Secure`: viaja por `http://localhost`, y el tramo de red va dentro de SSH.
 */
export const DEVICE_COOKIE = 'agent_workbench_device';

/** 400 dias: el tope que aceptan los navegadores. Se renueva en cada carga de la pagina. */
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

export function buildDeviceCookie(credential: string): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(credential)}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; SameSite=Strict; HttpOnly`;
}

/** Con que entro una peticion: el token de este arranque, o la credencial de un equipo emparejado. */
export type Credential =
  | { kind: 'session'; source: TokenSource }
  | { kind: 'device'; deviceId: string; credential: string };

/**
 * La credencial de una peticion, o null.
 *
 * Manda el token del arranque: es el de quien esta sentado en este equipo.
 * `devices` es null con el acceso remoto apagado, y ahi la cookie de un equipo
 * no se mira siquiera. La credencial de equipo entra **solo** por su cookie: ni
 * por la direccion —quedaria en el historial— ni como si fuera el token.
 */
export function matchCredential(
  request: IncomingMessage,
  token: string,
  devices: DeviceVerifier | null,
): Credential | null {
  const session = matchToken(request, token);
  if (session !== null) return { kind: 'session', source: session.source };
  if (devices === null) return null;

  const credential = readCookie(request, DEVICE_COOKIE);
  if (credential === null) return null;
  const device = devices.match(credential);
  return device === null ? null : { kind: 'device', deviceId: device.id, credential };
}

/** El codigo para emparejar que trae la direccion, tal como lo tecleo alguien, o null. */
export function readPairingCode(request: IncomingMessage): string | null {
  const code = requestUrl(request)?.searchParams.get(PAIR_QUERY_PARAM) ?? null;
  return code !== null && code.length > 0 ? code : null;
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

export type Authorization =
  | { ok: true; credential: Credential }
  | { ok: false; reason: RejectionReason };

/**
 * Chequeo unico que aplican tanto las rutas HTTP como el upgrade del WebSocket.
 *
 * `Host` y `Origin` van **antes** que la credencial, y valen igual para un
 * equipo emparejado: con una credencial buena pero llegando por el nombre de
 * red del equipo (`192.168.1.20:24837`) no se entra. Por el tunel se llega como
 * `localhost`, y es la unica forma.
 */
export function authorizeRequest(
  request: IncomingMessage,
  port: number,
  token: string,
  devices: DeviceVerifier | null,
): Authorization {
  if (!hasValidHost(request, port)) return { ok: false, reason: 'bad-host' };
  if (!hasValidOrigin(request, port)) return { ok: false, reason: 'bad-origin' };
  const credential = matchCredential(request, token, devices);
  return credential === null ? { ok: false, reason: 'bad-token' } : { ok: true, credential };
}
