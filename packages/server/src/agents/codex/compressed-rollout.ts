/**
 * Los rollouts comprimidos de Codex: `rollout-…-<uuid>.jsonl.zst`.
 *
 * La app de escritorio de Codex, que comparte `CODEX_HOME` con la CLI,
 * comprime los rollouts con zstd: medido el 15-10-2026, los 17 de esta maquina
 * al abrirse, con la fecha original. Es el JSONL entero, sin otro cambio. La
 * CLI 0.162.1 no comprime por defecto, y `codex resume <id>` de una comprimida
 * la **reemplaza** por el `.jsonl` y sigue escribiendo ahi (§10.12).
 *
 * Se descomprime en memoria, entero, y se entrega con la forma de un archivo
 * (`JsonlFileAccess`): la cabeza y la cola de la barra, el seguidor y la copia
 * propia leen igual que de un `.jsonl`. Nada se escribe en disco.
 *
 * `fzstd` y no `node:zlib`: zstd llego a `zlib` en la 22.15, y la app corre
 * desde la 20.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Decompress } from 'fzstd';
import { DISK_FILES, type JsonlFileAccess, type JsonlHandle } from '../../jsonl-reader.js';

export const COMPRESSED_ROLLOUT_SUFFIX = '.zst';

/**
 * Topes de un rollout comprimido. Los de esta maquina pesan de 16 a 105 KB
 * comprimidos y de 41 a 587 KB descomprimidos; el tope de salida es el que
 * corta un archivo que no es lo que dice ser antes de llevarse la memoria.
 */
export const COMPRESSED_ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;
export const DECOMPRESSED_ROLLOUT_MAX_BYTES = 256 * 1024 * 1024;

/** true si la ruta es la de un rollout comprimido (solo mira el nombre). */
export function isCompressedRollout(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(`.jsonl${COMPRESSED_ROLLOUT_SUFFIX}`);
}

/** La ruta del `.jsonl` de un comprimido: la que escribe `codex resume` al reemplazarlo. */
export function plainRolloutPathOf(compressedPath: string): string {
  return compressedPath.slice(0, -COMPRESSED_ROLLOUT_SUFFIX.length);
}

/** La ruta del comprimido de un `.jsonl`, en la misma carpeta. */
export function compressedRolloutPathOf(plainPath: string): string {
  return `${plainPath}${COMPRESSED_ROLLOUT_SUFFIX}`;
}

/** Descomprime los bytes de un rollout. Lanza si no es zstd o si pasa el tope. */
export function decompressRolloutBytes(compressed: Uint8Array): Buffer {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Decompress((chunk) => {
    total += chunk.length;
    if (total > DECOMPRESSED_ROLLOUT_MAX_BYTES) {
      throw new Error(`Compressed rollout over ${DECOMPRESSED_ROLLOUT_MAX_BYTES} bytes once decompressed`);
    }
    chunks.push(chunk);
  });
  stream.push(compressed, true);
  return Buffer.concat(chunks, total);
}

/** El contenido descomprimido de un rollout `.jsonl.zst`. Lanza si no existe o no se puede leer. */
export async function readCompressedRollout(filePath: string): Promise<Buffer> {
  const info = await stat(filePath);
  if (info.size > COMPRESSED_ROLLOUT_MAX_BYTES) {
    throw new Error(`Compressed rollout over ${COMPRESSED_ROLLOUT_MAX_BYTES} bytes: ${path.basename(filePath)}`);
  }
  return decompressRolloutBytes(await readFile(filePath));
}

function memoryHandle(data: Buffer): JsonlHandle {
  return {
    async read(buffer, offset, length, position) {
      const start = Math.min(Math.max(0, position), data.length);
      const end = Math.min(data.length, start + Math.max(0, length));
      const bytesRead = data.copy(buffer, offset, start, end);
      return { bytesRead };
    },
    async stat() {
      return { size: data.length };
    },
    async close() {},
  };
}

/**
 * Acceso a rollouts para un lector: un `.jsonl` va al disco tal cual, y un
 * `.jsonl.zst` se entrega descomprimido.
 *
 * Guarda el ultimo descomprimido mientras el archivo no cambie (misma fecha y
 * tamano): el seguidor pregunta el tamano en cada vuelta, y un comprimido no
 * crece, asi que se descomprime una vez y despues cada vuelta es un `stat`.
 * Uno por lector: la barra lo tira al terminar cada sesion.
 */
export function createRolloutFiles(): JsonlFileAccess {
  let cached: { filePath: string; mtimeMs: number; size: number; data: Buffer } | null = null;

  const decompressed = async (filePath: string): Promise<Buffer> => {
    const info = await stat(filePath);
    if (cached !== null && cached.filePath === filePath && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.data;
    }
    const data = await readCompressedRollout(filePath);
    cached = { filePath, mtimeMs: info.mtimeMs, size: info.size, data };
    return data;
  };

  return {
    size: async (filePath) => (isCompressedRollout(filePath) ? (await decompressed(filePath)).length : DISK_FILES.size(filePath)),
    open: async (filePath) => (isCompressedRollout(filePath) ? memoryHandle(await decompressed(filePath)) : DISK_FILES.open(filePath)),
  };
}
