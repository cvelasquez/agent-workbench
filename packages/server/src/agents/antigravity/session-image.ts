/**
 * Carga de imagenes para una conversacion de Antigravity CLI.
 *
 * Soporta dos origenes de imagen:
 *  - `pasted`: imagenes adjuntadas desde el cuadro de escritura de Agent Workbench
 *    (guardadas en `pasteRoot()`).
 *  - `content`: imagenes adjuntas nativas reportadas en el transcript de Antigravity
 *    (array `media` con `mime_type` y `uri`, guardadas en `.user_uploaded/` o disco).
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_SUBMIT_IMAGE_BYTES, type ConversationImageSource } from '@agent-workbench/shared';
import { detectImageFormat } from '../../image-signature.js';
import { pasteRoot } from '../../paste-paths.js';
import { resolveInside } from '../../path-guard.js';
import type { LoadedImage } from '../adapter.js';

export interface AntigravityImageTarget {
  readonly pastedPaths: readonly string[];
  readonly contentMedia: readonly { readonly mimeType: string; readonly uri: string }[];
}

/**
 * Lee un archivo de imagen pegado en el cuadro de escritura, verificado
 * contra `pastedDir`.
 */
export async function readPastedImage(target: string, pastedDir: string = pasteRoot()): Promise<LoadedImage | null> {
  try {
    const inside = await resolveInside(pastedDir, path.relative(pastedDir, target), { mustExist: true });
    const info = await stat(inside);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SUBMIT_IMAGE_BYTES) return null;
    const bytes = await readFile(inside);
    const format = detectImageFormat(bytes);
    return format === null ? null : { mediaType: format.mediaType, data: bytes.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * Lee una imagen del transcript nativo (e.g. guardada en `.user_uploaded/`).
 */
export async function readContentImage(uri: string): Promise<LoadedImage | null> {
  try {
    const normalized = path.resolve(uri);
    const info = await stat(normalized);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SUBMIT_IMAGE_BYTES) return null;
    const bytes = await readFile(normalized);
    const format = detectImageFormat(bytes);
    return {
      mediaType: format?.mediaType ?? 'image/png',
      data: bytes.toString('base64'),
    };
  } catch {
    return null;
  }
}

/**
 * Resuelve y carga la imagen para el evento e indice solicitados.
 */
export async function loadAntigravityImage(
  targets: AntigravityImageTarget | undefined,
  index: number,
  source: ConversationImageSource,
  pastedDir: string = pasteRoot(),
): Promise<LoadedImage | null> {
  if (targets === undefined || !Number.isInteger(index) || index < 0) return null;

  if (source === 'pasted') {
    const target = targets.pastedPaths[index];
    if (target === undefined) return null;
    return readPastedImage(target, pastedDir);
  }

  if (source === 'content') {
    const mediaItem = targets.contentMedia[index];
    if (mediaItem === undefined) return null;
    return readContentImage(mediaItem.uri);
  }

  return null;
}
