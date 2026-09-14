/**
 * Escribir una sesion en la copia (hito 28, D2).
 *
 * Cada sesion es un archivo que se **regenera entero y se reemplaza de una**:
 * se escribe un temporal en la misma carpeta y se renombra encima. Quien lee
 * —el catalogo, un sincronizador, otra instancia de la app— ve el archivo
 * viejo o el nuevo, nunca uno a medias. Por eso "escribir dos veces no
 * duplica" sale solo.
 *
 * Tres detalles:
 *
 *  - **Los assets van antes que el `.jsonl`.** Una cabecera nueva que nombra un
 *    asset que todavia no esta es una imagen rota si el proceso muere entre las
 *    dos escrituras; al reves, lo peor es un asset huerfano. Tambien van por
 *    temporal: el nombre es el hash, y uno a medias con el nombre bueno se
 *    reusaria para siempre.
 *  - **`vault.json` se escribe si falta.** Es lo que dice que la carpeta es una
 *    copia: sin el, cambiar de carpeta no la mudaria (`vault.setDir` solo mueve
 *    una carpeta que lo tiene) y un importador que escribe primero dejaria
 *    sesiones que nadie reconoce.
 *  - **En Windows el `rename` se reintenta** ante `EPERM` o `EBUSY`: un
 *    sincronizador (OneDrive) o un antivirus que tiene el destino abierto un
 *    instante. Tres reintentos a 100 ms; despues lanza y el temporal se borra.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { VAULT_FORMAT } from '@agent-workbench/shared';
import { agentSessionsDir, assetFile, assetsDir, sessionFile, vaultMarkerFile } from './paths.js';
import type { SerializedSession } from './serialize.js';

const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 100;

/** Lo que se puede cambiar para probar los reintentos sin un sincronizador de verdad. */
export interface VaultWriteDeps {
  rename: (from: string, to: string) => Promise<void>;
  platform: string;
  delay: (ms: number) => Promise<void>;
  now: () => number;
}

export const DEFAULT_WRITE_DEPS: VaultWriteDeps = {
  rename,
  platform: process.platform,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * `<nombre>.<pid>.<aleatorio>.tmp`, en la carpeta del destino: el `rename` no
 * cruza unidades, y dos instancias de la app no comparten temporal. El catalogo
 * solo mira `*.jsonl`, asi que uno que quedo suelto no aparece.
 */
export function temporaryPathFor(target: string): string {
  return `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

function isRetryableRename(error: unknown, platform: string): boolean {
  if (platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

/** Escribe `data` en `target` por temporal. Si no se puede renombrar, borra el temporal y lanza. */
export async function writeFileAtomic(
  target: string,
  data: string | Buffer,
  deps: VaultWriteDeps = DEFAULT_WRITE_DEPS,
): Promise<void> {
  const temporary = temporaryPathFor(target);
  try {
    await writeFile(temporary, data);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await deps.rename(temporary, target);
        return;
      } catch (error) {
        if (attempt >= RENAME_RETRIES || !isRetryableRename(error, deps.platform)) throw error;
        await deps.delay(RENAME_RETRY_MS);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** `vault.json` si la carpeta todavia no lo tiene. No reescribe uno existente, conozca o no su formato. */
export async function ensureVaultMarker(dir: string, deps: VaultWriteDeps = DEFAULT_WRITE_DEPS): Promise<void> {
  const marker = vaultMarkerFile(dir);
  try {
    await stat(marker);
    return;
  } catch {
    // No esta: se escribe.
  }
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(marker, `${JSON.stringify({ format: VAULT_FORMAT, createdAt: deps.now() })}\n`, deps);
}

export interface WrittenSession {
  file: string;
  /** Bytes del `.jsonl`. */
  bytes: number;
  /** Assets que hubo que escribir (los que ya estaban, con el mismo tamano, no cuentan). */
  assetsWritten: number;
  assetBytesWritten: number;
}

/** true si el asset ya esta con ese tamano. El nombre es el hash: mismo nombre y tamano es el mismo contenido. */
async function assetPresent(file: string, size: number): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size === size;
  } catch {
    return false;
  }
}

/**
 * Escribe una sesion serializada en la copia `dir`: la carpeta, `vault.json` si
 * falta, los assets que falten y el `.jsonl` por temporal.
 */
export async function writeSessionFile(
  dir: string,
  serialized: SerializedSession,
  deps: VaultWriteDeps = DEFAULT_WRITE_DEPS,
): Promise<WrittenSession> {
  const { agent, sessionId } = serialized.header;
  const file = sessionFile(dir, agent, sessionId);

  await ensureVaultMarker(dir, deps);
  await mkdir(agentSessionsDir(dir, agent), { recursive: true });

  let assetsWritten = 0;
  let assetBytesWritten = 0;
  if (serialized.assets.size > 0) {
    await mkdir(assetsDir(dir, agent, sessionId), { recursive: true });
    for (const [name, bytes] of serialized.assets) {
      const target = assetFile(dir, agent, sessionId, name);
      if (await assetPresent(target, bytes.length)) continue;
      await writeFileAtomic(target, bytes, deps);
      assetsWritten += 1;
      assetBytesWritten += bytes.length;
    }
  }

  const text = Buffer.from(serialized.text, 'utf8');
  await writeFileAtomic(file, text, deps);
  return { file, bytes: text.length, assetsWritten, assetBytesWritten };
}
