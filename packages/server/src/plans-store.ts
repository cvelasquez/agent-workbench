/**
 * Los planes que escribio una conversacion.
 *
 * La CLI, en modo plan, escribe el plan en `~/.claude/plans/<archivo>.md` y lo
 * nombra en el JSONL de dos formas distintas (`toPlanFileName`). Este modulo
 * es lo unico que abre esos archivos, y es **solo lectura**: es la tercera
 * carpeta de `~/.claude/` que la aplicacion lee y, como las otras dos, no se
 * escribe nunca (CLAUDE.md 2.1).
 *
 * **El cliente nunca nombra una ruta.** Lo que viaja es el nombre del archivo
 * que el propio servidor le mando en la lista de planes de esa pestana; la
 * carpeta la pone `plansRoot()` y el nombre se vuelve a validar aca. Sin esto
 * daria igual escuchar solo en loopback: un mensaje bastaria para leer
 * cualquier archivo del disco (§2.4).
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PlanContent, SessionPlan } from '@agent-workbench/shared';
import { plansRoot } from './paths.js';

/**
 * Tope de lo que se manda al navegador.
 *
 * Un plan es un documento para leer, no un volcado: los tres de esta
 * instalacion pesan entre 10 y 13 KB. 256 KB deja muchisimo margen y sigue
 * siendo un solo mensaje del socket.
 */
const MAX_PLAN_BYTES = 256 * 1024;

/**
 * true si el nombre es un archivo suelto de la carpeta de planes.
 *
 * Se comprueba aunque el nombre haya salido de nuestra propia lista: es el
 * unico punto por el que el nombre se convierte en una ruta, y una validacion
 * que depende de que el llamador se haya acordado no es una validacion.
 */
function isPlanFileName(fileName: string): boolean {
  if (fileName.length === 0 || fileName.length > 255) return false;
  if (fileName.includes('\0')) return false;
  // `basename` desarma cualquier `..`, separador o unidad de Windows: si lo que
  // queda no es identico, la ruta llevaba a otro lado.
  if (path.basename(fileName) !== fileName) return false;
  if (fileName === '.' || fileName === '..') return false;
  return fileName.toLowerCase().endsWith('.md');
}

function titleOf(fileName: string): string {
  return fileName.replace(/\.md$/i, '');
}

/**
 * Describe los planes de una conversacion, en el orden en que los nombro.
 *
 * Un plan que ya no esta en disco se devuelve igual, con `exists: false`: la
 * conversacion lo nombro y esconderlo dejaria un hueco sin explicacion. Pasa
 * de verdad — una linea `plan_mode` puede anunciar un archivo que la CLI
 * todavia no escribio.
 */
export async function describePlans(fileNames: readonly string[]): Promise<SessionPlan[]> {
  const root = plansRoot();
  const plans: SessionPlan[] = [];

  for (const fileName of fileNames) {
    if (!isPlanFileName(fileName)) continue;

    const plan: SessionPlan = {
      fileName,
      title: titleOf(fileName),
      exists: false,
      modifiedAt: 0,
      sizeBytes: 0,
    };

    try {
      const info = await stat(path.join(root, fileName));
      if (info.isFile()) {
        plan.exists = true;
        plan.modifiedAt = info.mtimeMs;
        plan.sizeBytes = info.size;
      }
    } catch {
      // Borrado, o nunca escrito. Se lista igual.
    }

    plans.push(plan);
  }

  return plans;
}

/** Contenido de un plan, recortado. null si no esta o no se puede leer. */
export async function readPlan(fileName: string): Promise<PlanContent | null> {
  if (!isPlanFileName(fileName)) return null;

  try {
    const content = await readFile(path.join(plansRoot(), fileName));
    const truncated = content.length > MAX_PLAN_BYTES;
    return {
      fileName,
      text: content.subarray(0, MAX_PLAN_BYTES).toString('utf8'),
      truncated,
    };
  } catch {
    return null;
  }
}
