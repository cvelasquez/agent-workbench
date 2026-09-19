/**
 * Las rutas de la copia propia (hito 28).
 *
 * Todo lo que la copia escribe cuelga de una carpeta —la configurada, o la de
 * por defecto dentro de la carpeta de la app— y **cada nombre de adentro lo
 * arma el servidor**: un `sessionId` con la forma de `VAULT_SESSION_ID_PATTERN`,
 * un id de fuente conocido, un asset con nombre de hash, o un nombre saneado.
 * Nada que llegue del cliente ni de un archivo editado a mano termina siendo
 * una ruta sin pasar por aca (CLAUDE.md 2.4).
 *
 * ```
 * <copia>/
 *   vault.json
 *   sessions/<agent>/<sessionId>.jsonl
 *   sessions/<agent>/<sessionId>.assets/<hash>.<ext>
 *   memory/<nombre de carpeta>-<hash8>/
 *   export/<nombre de carpeta>-<hash8>/
 *   export/sesiones/<agent>-<sessionId>.md
 * ```
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SESSION_AGENT_IDS,
  VAULT_ASSET_NAME_PATTERN,
  isVaultSessionId,
  normalizeCwdKey,
  type SessionAgentId,
} from '@agent-workbench/shared';
import { appConfigDir } from '../paths.js';

/** La carpeta de la copia cuando `settings.json` no nombra otra. */
export function defaultVaultDir(): string {
  return path.join(appConfigDir(), 'vault');
}

/** Lo que dice que una carpeta es una copia: `{"format":1,"createdAt":<ms>}`. */
export function vaultMarkerFile(dir: string): string {
  return path.join(dir, 'vault.json');
}

export function sessionsRoot(dir: string): string {
  return path.join(dir, 'sessions');
}

/** true si el id se puede escribir o leer de la copia: no puede ser una ruta. */
export function isSafeSessionId(sessionId: string): boolean {
  return isVaultSessionId(sessionId);
}

function isSessionAgentId(value: string): value is SessionAgentId {
  return (SESSION_AGENT_IDS as readonly string[]).includes(value);
}

/**
 * Lanza si el par no se puede convertir en ruta. El tipo ya dice que `agent` es
 * conocido, pero lo que se escribe puede venir de una cabecera leida de disco o
 * de un importador: se comprueba igual, en el unico lugar que arma la ruta.
 */
function assertSessionKey(agent: string, sessionId: string): void {
  if (!isSessionAgentId(agent)) throw new Error(`Unknown source for the local copy: ${JSON.stringify(agent)}`);
  if (!isSafeSessionId(sessionId)) throw new Error(`Session id that isn't copied: ${JSON.stringify(sessionId)}`);
}

export function agentSessionsDir(dir: string, agent: SessionAgentId): string {
  if (!isSessionAgentId(agent)) throw new Error(`Unknown source for the local copy: ${JSON.stringify(agent)}`);
  return path.join(sessionsRoot(dir), agent);
}

export function sessionFile(dir: string, agent: SessionAgentId, sessionId: string): string {
  assertSessionKey(agent, sessionId);
  return path.join(sessionsRoot(dir), agent, `${sessionId}.jsonl`);
}

export function assetsDir(dir: string, agent: SessionAgentId, sessionId: string): string {
  assertSessionKey(agent, sessionId);
  return path.join(sessionsRoot(dir), agent, `${sessionId}.assets`);
}

/** Un asset de una sesion. Lanza si el nombre no es el de un hash: vendria de disco, no de nosotros. */
export function assetFile(dir: string, agent: SessionAgentId, sessionId: string, asset: string): string {
  if (!VAULT_ASSET_NAME_PATTERN.test(asset)) throw new Error(`Invalid asset name: ${JSON.stringify(asset)}`);
  return path.join(assetsDir(dir, agent, sessionId), asset);
}

/**
 * `<nombre de carpeta>-<hash8>`: se reconoce a simple vista y dos proyectos con
 * el mismo nombre de carpeta no se pisan. El hash es de la clave normalizada,
 * asi que `D:\x` y `d:\x\` dan la misma carpeta, igual que en la barra.
 */
export function projectFolderName(cwd: string, platform: string): string {
  const hash = createHash('sha256').update(normalizeCwdKey(cwd, platform)).digest('hex').slice(0, 8);
  const base = (platform === 'win32' ? path.win32 : path.posix).basename(cwd);
  const name = base.length === 0 ? 'proyecto' : sanitizeFileName(base, 60);
  return `${name}-${hash}`;
}

export function memoryDir(dir: string, cwd: string, platform: string): string {
  return path.join(dir, 'memory', projectFolderName(cwd, platform));
}

export function projectExportDir(dir: string, cwd: string, platform: string): string {
  return path.join(dir, 'export', projectFolderName(cwd, platform));
}

/**
 * La carpeta de exportacion de un proyecto de la barra. Con `cwd`, la de
 * `projectExportDir`. Sin `cwd` (un proyecto `unknown:`), el nombre para
 * mostrar y el hash de su clave: dos proyectos sin carpeta no se pisan.
 */
export function projectExportDirFor(
  dir: string,
  project: { key: string; cwd: string; fallbackName: string },
  platform: string,
): string {
  if (project.cwd.length > 0) return projectExportDir(dir, project.cwd, platform);
  const hash = createHash('sha256').update(project.key).digest('hex').slice(0, 8);
  const name = project.fallbackName.length > 0 ? sanitizeFileName(project.fallbackName, 60) : 'proyecto';
  return path.join(dir, 'export', `${name}-${hash}`);
}

export function sessionExportFile(dir: string, agent: SessionAgentId, sessionId: string): string {
  assertSessionKey(agent, sessionId);
  return path.join(dir, 'export', 'sesiones', `${agent}-${sessionId}.md`);
}

/** Nombres que Windows reserva para dispositivos, con o sin extension. */
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Un texto cualquiera —un titulo, el nombre de una carpeta— convertido en un
 * nombre de archivo que sirve en los tres sistemas.
 *
 * **Se conserva solo lo que se sabe inofensivo**: letras, marcas y digitos de
 * cualquier alfabeto, espacio, `.`, `_` y `-`. El resto pasa a `_`. No es una
 * lista de prohibidos porque el nombre termina en `cmd.exe /c start "" <ruta>`
 * (`reveal.ts`), y ahi un `&`, un `^` o un `%` sin espacios alrededor parte el
 * comando (C12): una carpeta `R&D` o un titulo generado alcanzan.
 *
 * Ademas: sin puntos ni espacios al final (Windows los quita y el nombre deja
 * de ser el que se escribio), con `_` delante de `CON`, `NUL`, `COM1`… y a lo
 * sumo `max` caracteres. Nunca vacio, y nunca `.` ni `..`.
 */
export function sanitizeFileName(text: string, max = 80): string {
  const limit = Math.max(1, Math.floor(max));
  const kept = text.normalize('NFC').replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '_');
  const trimEnds = (value: string): string => value.replace(/^ +/u, '').replace(/[. ]+$/u, '');

  let name = trimEnds(Array.from(trimEnds(kept)).slice(0, limit).join(''));
  if (name.length === 0) return '_';

  const stem = (name.split('.')[0] ?? '').replace(/ +$/u, '');
  if (RESERVED_WINDOWS_NAME.test(stem)) {
    name = `_${Array.from(name).slice(0, limit - 1).join('')}`;
    name = name.replace(/[. ]+$/u, '');
  }
  return name;
}
