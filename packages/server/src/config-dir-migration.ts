/**
 * La app se llamo Agent Explorer hasta septiembre de 2026, y su directorio de
 * configuracion tambien. Lo que hay ahi —pestanas abiertas, sesiones
 * archivadas, notas con sus imagenes— es del usuario, y un cambio de nombre no
 * puede hacerselo perder.
 *
 * Una sola vez, al arrancar: si el directorio nuevo no existe y el viejo si, se
 * mueve entero. Es un `rename` dentro del mismo padre, asi que no copia nada y
 * no puede dejar las dos mitades a medias. Si el nuevo ya existe no se toca
 * nada: lo que haya en el viejo queda donde esta, sin pisar lo mas reciente.
 */
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { appConfigDir, legacyAppConfigDir } from './paths.js';

/** Devuelve el directorio viejo si lo movio, o `null` si no habia nada que mover. */
export async function migrateLegacyConfigDir(): Promise<string | null> {
  const legacy = legacyAppConfigDir();
  const current = appConfigDir();
  if (existsSync(current) || !existsSync(legacy)) return null;
  await rename(legacy, current);
  return legacy;
}
