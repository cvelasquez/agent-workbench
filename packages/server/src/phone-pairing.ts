/**
 * Emparejar un teléfono (hito 38, §15): lo que se arma sin tocar disco ni red.
 *
 * El teléfono llega a la app por el mismo túnel SSH que cualquier otro equipo
 * (§14), pero no tiene dónde teclear una llave. La arma este equipo **en
 * memoria**, y la privada viaja al teléfono dentro del código QR, junto con el
 * código de un solo uso de §14.3. Lo único que hace el usuario en este equipo es
 * pegar la línea que autoriza la pública: **la app no escribe
 * `authorized_keys`**, que está fuera de donde escribe (§2.1).
 *
 * La línea sale restringida. La llave sólo sirve para reenviar el puerto de la
 * app, y no ejecuta nada: `command="exit"`. Medido en el hito (S6), con la 10.0
 * portátil y con la 9.5 que instala Windows: `restrict` solo no alcanza, y la
 * llave seguía ejecutando comandos.
 *
 * El texto del QR es una dirección con su versión, para que el teléfono
 * rechace una que no entiende:
 *
 *   agentworkbench://pair?v=1&n=<equipo>&h=<ip>,<ip>&p=22&u=<usuario>&a=<puerto>&c=<código>&k=<semilla>
 *
 * `k` es la semilla Ed25519, 32 bytes en base64url: el teléfono deriva la
 * pública. Así el QR queda chico —se lee de lejos— y no hace falta armar el
 * formato de archivo de OpenSSH en ningún lado.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { PhoneAuthorizeShell } from '@agent-workbench/shared';

export const PHONE_PAYLOAD_PREFIX = 'agentworkbench://pair?';
export const PHONE_PAYLOAD_VERSION = 1;
/** El puerto del servidor SSH de este equipo: el de siempre, que no cambia la guía del README. */
export const PHONE_SSH_PORT = 22;
/** El comentario de la llave: dice de dónde salió a quien lea `authorized_keys`. */
export const PHONE_KEY_COMMENT = 'agent-workbench-phone';
export const PHONE_SEED_BYTES = 32;

/** El encabezado PKCS#8 de una llave privada Ed25519: lo que va antes de los 32 bytes de la semilla. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** La pública de una semilla Ed25519. Lanza si la semilla no tiene 32 bytes. */
export function ed25519PublicKey(seed: Buffer): Buffer {
  if (seed.length !== PHONE_SEED_BYTES) throw new Error(`an Ed25519 seed has ${PHONE_SEED_BYTES} bytes`);
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/** Un `string` del protocolo SSH: el largo en cuatro bytes y el contenido. */
function sshString(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** `ssh-ed25519 AAAA…`, como la escribe `ssh-keygen`. */
export function sshEd25519PublicKey(publicKey: Buffer): string {
  const blob = Buffer.concat([sshString(Buffer.from('ssh-ed25519', 'ascii')), sshString(publicKey)]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

/**
 * La línea de `authorized_keys`: la llave sólo reenvía el puerto de la app, y
 * sólo hacia este equipo; no abre una terminal ni ejecuta nada.
 */
export function phoneAuthorizedKeysEntry(publicKey: Buffer, appPort: number): string {
  return `restrict,port-forwarding,permitopen="127.0.0.1:${appPort}",command="exit" ${sshEd25519PublicKey(publicKey)} ${PHONE_KEY_COMMENT}`;
}

/**
 * Lo que el usuario pega en este equipo para autorizar la llave. Una línea, sin
 * nada que cambiar a mano.
 *
 *  - **Windows, usuario administrador:** OpenSSH lee
 *    `administrators_authorized_keys`, que sólo pueden tocar los
 *    administradores y SYSTEM. Los permisos se dan por SID: el grupo se llama
 *    distinto en cada idioma de Windows (medido en uno en español).
 *  - **Windows, usuario común:** `~/.ssh/authorized_keys`, sin elevar.
 *  - **macOS y Linux:** lo mismo, con los permisos que pide `StrictModes`.
 *
 * La línea vacía de antes cierra la última del archivo si no terminaba en salto
 * de línea; si terminaba, queda una línea en blanco, que OpenSSH ignora.
 */
export function phoneAuthorizeCommand(entry: string, shell: PhoneAuthorizeShell): string {
  switch (shell) {
    case 'powershell-admin':
      return (
        `$f = "$env:ProgramData\\ssh\\administrators_authorized_keys"; ` +
        `Add-Content -Path $f -Encoding ascii -Value @('', '${entry}'); ` +
        `icacls.exe $f /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F'`
      );
    case 'powershell':
      return (
        `New-Item -ItemType Directory -Force "$HOME\\.ssh" | Out-Null; ` +
        `Add-Content -Path "$HOME\\.ssh\\authorized_keys" -Encoding ascii -Value @('', '${entry}')`
      );
    case 'terminal':
      return (
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
        `printf '\\n%s\\n' '${entry}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
      );
  }
}

/**
 * Qué consola corresponde en Windows, según la salida de `whoami /groups /fo csv /nh`:
 * con el grupo de administradores (S-1-5-32-544) es la de administrador. El SID
 * aparece aunque la consola no esté elevada: el grupo figura "sólo para denegar".
 */
export function authorizeShellFromGroups(whoamiGroups: string): PhoneAuthorizeShell {
  return /S-1-5-32-544/.test(whoamiGroups) ? 'powershell-admin' : 'powershell';
}

export interface PhonePayloadFields {
  /** El nombre de este equipo, para que el teléfono lo muestre. */
  pcName: string;
  /** Por dónde probar: las IPv4 privadas de este equipo, en orden. */
  hosts: readonly string[];
  sshPort: number;
  /** Con qué usuario se entra por SSH. */
  user: string;
  /** El puerto de la app: el túnel lo usa en los dos extremos (§14.2). */
  appPort: number;
  /** El código de un solo uso, sin guion. */
  code: string;
  seed: Buffer;
}

/** El texto del código QR. */
export function phonePairingPayload(fields: PhonePayloadFields): string {
  const params = new URLSearchParams();
  params.set('v', String(PHONE_PAYLOAD_VERSION));
  params.set('n', fields.pcName);
  params.set('h', fields.hosts.join(','));
  params.set('p', String(fields.sshPort));
  params.set('u', fields.user);
  params.set('a', String(fields.appPort));
  params.set('c', fields.code);
  params.set('k', fields.seed.toString('base64url'));
  return PHONE_PAYLOAD_PREFIX + params.toString();
}

/**
 * Lee el texto del QR, o null si no es de esta versión o le falta algo. El
 * teléfono tiene su propio lector (`PairingPayload.kt`); este existe para que el
 * chequeo compruebe que lo que sale se lee igual y no lleva nada de más.
 */
export function parsePhonePairingPayload(text: string): PhonePayloadFields | null {
  if (!text.startsWith(PHONE_PAYLOAD_PREFIX)) return null;
  const params = new URLSearchParams(text.slice(PHONE_PAYLOAD_PREFIX.length));
  if (params.get('v') !== String(PHONE_PAYLOAD_VERSION)) return null;
  const pcName = params.get('n');
  const hosts = (params.get('h') ?? '').split(',').filter((host) => host.length > 0);
  const sshPort = Number(params.get('p'));
  const user = params.get('u');
  const appPort = Number(params.get('a'));
  const code = params.get('c');
  const seedText = params.get('k');
  if (pcName === null || user === null || code === null || seedText === null || hosts.length === 0) return null;
  if (!Number.isInteger(sshPort) || !Number.isInteger(appPort)) return null;
  const seed = Buffer.from(seedText, 'base64url');
  if (seed.length !== PHONE_SEED_BYTES) return null;
  return { pcName, hosts, sshPort, user, appPort, code, seed };
}
