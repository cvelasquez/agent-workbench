/**
 * Reemplazar un archivo sin dejarlo por la mitad: temporal en la misma carpeta
 * y `rename`.
 *
 * Salio de `memory-bridge.ts` en el Hito 46 sin cambiar lo que hace, para que lo
 * use tambien guardar un archivo desde Archivos (§6.36). Las dos son las unicas
 * escrituras de la app dentro de un proyecto (CLAUDE.md 2.1).
 *
 *  - **El temporal se crea en exclusiva** (`wx`: falla si ya hay algo con ese
 *    nombre, enlace incluido) y con un sufijo aleatorio. Con un nombre
 *    predecible y `writeFile`, un enlace duro o simbolico puesto de antemano en
 *    `.AGENTS.md.<pid>.tmp` hacia un archivo de afuera recibia la escritura, y
 *    el `rename` dejaba despues el `AGENTS.md` enlazado a ese archivo. Un choque
 *    de nombres se reintenta con otro sufijo; lo que ya existe no se abre nunca,
 *    y tampoco se borra: no es nuestro.
 *  - **El `rename` se reintenta en Windows**, donde un antivirus puede tener el
 *    temporal abierto un instante.
 *  - **Si algo falla, el temporal se borra**, y el destino queda como estaba.
 */

import { randomBytes } from 'node:crypto';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/** Reintentos del `rename` en Windows, donde un antivirus puede tener el temporal abierto. */
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 40;
/** Intentos de crear un temporal con nombre libre. Chocar dos veces ya no es azar. */
const TEMPORARY_ATTEMPTS = 5;

export interface AtomicWriteOptions {
  /**
   * Lo que se comprueba con el temporal ya escrito, justo antes del `rename`.
   * Si lanza, el temporal se borra y el destino no se toca.
   */
  beforeRename?: () => Promise<void>;
  /**
   * Los permisos del archivo que se reemplaza (`stat().mode`), fuera de Windows:
   * un `.env` en 600 no puede quedar en 644 por guardarlo. Con esto el temporal
   * nace en 600 y recien con todo escrito toma los del original. Sin esto, los
   * de siempre para un archivo nuevo.
   */
  mode?: number;
}

export async function writeAtomically(
  target: string,
  content: Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { temporary, handle } = await createTemporary(target, options.mode === undefined ? 0o666 : 0o600);
  try {
    try {
      await handle.writeFile(content);
      // En Windows `chmod` solo toca el atributo de solo lectura, y uno de solo
      // lectura no se reemplaza igual: ahi no se copia nada.
      if (options.mode !== undefined && process.platform !== 'win32') await handle.chmod(options.mode & 0o7777);
    } finally {
      await handle.close();
    }
    await options.beforeRename?.();
    await renameWithRetry(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function createTemporary(target: string, mode: number): Promise<{ temporary: string; handle: FileHandle }> {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = randomBytes(6).toString('hex');
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${suffix}.tmp`,
    );
    try {
      return { temporary, handle: await open(temporary, 'wx', mode) };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'EEXIST' || attempt >= TEMPORARY_ATTEMPTS) throw error;
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}
