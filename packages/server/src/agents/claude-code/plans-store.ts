/**
 * Los documentos markdown que escribio una conversacion.
 *
 * Hasta el hito 30 esto era solo el plan del modo plan: la CLI lo deja en
 * `~/.claude/plans/<archivo>.md` y lo nombra en el JSONL. Desde el 31 son
 * **tres** origenes, porque los dos nuevos eran justamente los que no se podian
 * abrir desde la app (`PlanOrigin`):
 *
 * | Ref | Raiz | Que es |
 * |---|---|---|
 * | `cli:<archivo>` | `plansRoot()` | el plan del modo plan, lo de siempre |
 * | `proj:<relativa>` | el `cwd` de la pestana | un `.md` que el agente escribio en el proyecto |
 * | `tmp:<relativa>` | `scratchRoot(cwd, sessionId)` | uno de la carpeta temporal de esa sesion |
 *
 * Este modulo es lo unico que abre esos archivos, y es **solo lectura**: no se
 * escribe nada en ninguna de las tres raices (CLAUDE.md 2.1).
 *
 * **El cliente nunca nombra una ruta** (§2.4). Lo que viaja es una ref que armo
 * este mismo servidor y que el hub ya comprobo contra la lista de la pestana;
 * aca se vuelve a validar igual, porque es el unico punto por el que una ref se
 * convierte en una ruta, y una validacion que depende de que el llamador se
 * haya acordado no es una validacion.
 *
 * Los dos origenes nuevos pasan ademas por `resolveInside`, el guardia del
 * panel de archivos (§6.3): resuelve los enlaces y comprueba que el resultado
 * siga adentro. Un `.md` que es un enlace a `~/.claude/.credentials.json` no se
 * lee, que es el mismo caso que §6.15 ya cubre para `CLAUDE.md`. El plan de la
 * CLI no lo necesita: su ref es un nombre suelto, sin separadores.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PlanContent, PlanOrigin, SessionPlan } from '@agent-workbench/shared';
import { resolveInside } from '../../path-guard.js';
import { plansRoot, scratchRoot } from './paths.js';

/**
 * Tope de lo que se manda al navegador.
 *
 * Un plan es un documento para leer, no un volcado: los tres de esta
 * instalacion pesan entre 10 y 13 KB. 256 KB deja muchisimo margen y sigue
 * siendo un solo mensaje del socket. Un `.md` del proyecto puede ser bastante
 * mas grande —el `CLAUDE.md` de este repositorio lo es— y ahi se corta y se
 * dice, como ya se decia.
 */
const MAX_PLAN_BYTES = 256 * 1024;

/** La pestana: de ella salen dos de las tres raices. */
export interface PlanTarget {
  cwd: string;
  sessionId: string;
}

const PREFIXES: Record<string, PlanOrigin> = {
  'cli:': 'cli-plans',
  'proj:': 'project',
  'tmp:': 'scratch',
};

/** Una ref ya desarmada en origen y ruta relativa. */
interface PlanRef {
  origin: PlanOrigin;
  /** Un nombre suelto en `cli-plans`; una ruta relativa posix en los otros dos. */
  path: string;
}

/**
 * true si el nombre es un archivo suelto de la carpeta de planes.
 *
 * Se comprueba aunque el nombre haya salido de nuestra propia lista: ver la
 * cabecera.
 */
function isPlanFileName(fileName: string): boolean {
  if (fileName.length === 0 || fileName.length > 255) return false;
  if (fileName.includes('\u0000')) return false;
  // `basename` desarma cualquier `..`, separador o unidad de Windows: si lo que
  // queda no es identico, la ruta llevaba a otro lado.
  if (path.basename(fileName) !== fileName) return false;
  if (fileName === '.' || fileName === '..') return false;
  return fileName.toLowerCase().endsWith('.md');
}

/**
 * true si la ruta relativa tiene forma de documento del proyecto o de la
 * temporal.
 *
 * Es la comprobacion **sintactica**; los enlaces los resuelve `resolveInside`
 * antes de abrir nada. Se rechaza lo absoluto y los `..` aca para que la ruta
 * ni siquiera llegue a componerse.
 */
function isDocumentPath(relative: string): boolean {
  if (relative.length === 0 || relative.length > 1024) return false;
  if (relative.includes('\u0000')) return false;
  if (!relative.toLowerCase().endsWith('.md')) return false;
  if (relative.startsWith('/') || relative.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(relative)) return false;
  const segments = relative.split('/');
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\'),
  );
}

/** Desarma una ref. null si no tiene una forma que se pueda abrir. */
function parseRef(ref: string): PlanRef | null {
  for (const [prefix, origin] of Object.entries(PREFIXES)) {
    if (!ref.startsWith(prefix)) continue;
    const rest = ref.slice(prefix.length);
    if (origin === 'cli-plans') {
      return isPlanFileName(rest) ? { origin, path: rest } : null;
    }
    return isDocumentPath(rest) ? { origin, path: rest } : null;
  }
  return null;
}

/**
 * La ruta absoluta de una ref, ya validada contra la raiz de su origen.
 *
 * null si la ref no tiene forma, si su raiz no se puede armar —una pestana sin
 * `cwd`, o sin sesion para la temporal— o si el guardia la rechaza.
 */
async function resolveRef(ref: PlanRef, target: PlanTarget): Promise<string | null> {
  if (ref.origin === 'cli-plans') return path.join(plansRoot(), ref.path);
  if (target.cwd.length === 0) return null;

  const root =
    ref.origin === 'scratch'
      ? target.sessionId.length === 0
        ? null
        : scratchRoot(target.cwd, target.sessionId)
      : target.cwd;
  if (root === null) return null;

  try {
    return await resolveInside(root, ref.path);
  } catch {
    // Sale del proyecto, o es un enlace que apunta afuera. No se abre.
    return null;
  }
}

/** El nombre sin extension, que es lo que se muestra. */
function titleOf(relative: string): string {
  return (path.posix.basename(relative) || relative).replace(/\.md$/i, '');
}

/**
 * Describe los documentos de una conversacion, en el orden en que los nombro.
 *
 * Uno que ya no esta en disco se devuelve igual, con `exists: false`: la
 * conversacion lo nombro y esconderlo dejaria un hueco sin explicacion. Pasa de
 * verdad — una linea `plan_mode` puede anunciar un archivo que la CLI todavia
 * no escribio, y lo que el agente deja en la carpeta temporal se borra solo con
 * el tiempo.
 *
 * Una ref que no se puede resolver **tampoco se esconde**: se lista como que ya
 * no esta. Es lo mismo que ve el usuario, y callarla dejaria el mismo hueco.
 */
export async function describePlans(
  target: PlanTarget,
  refs: readonly string[],
): Promise<SessionPlan[]> {
  const plans: SessionPlan[] = [];

  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (parsed === null) continue;

    const plan: SessionPlan = {
      fileName: ref,
      title: titleOf(parsed.path),
      origin: parsed.origin,
      // La carpeta de un plan de la CLI no aporta nada: es siempre la misma.
      path: parsed.origin === 'cli-plans' ? '' : parsed.path,
      exists: false,
      modifiedAt: 0,
      sizeBytes: 0,
    };

    const absolute = await resolveRef(parsed, target);
    if (absolute !== null) {
      try {
        const info = await stat(absolute);
        if (info.isFile()) {
          plan.exists = true;
          plan.modifiedAt = info.mtimeMs;
          plan.sizeBytes = info.size;
        }
      } catch {
        // Borrado, o nunca escrito. Se lista igual.
      }
    }

    plans.push(plan);
  }

  return plans;
}

/** Contenido de un documento, recortado. null si no esta o no se puede leer. */
export async function readPlan(target: PlanTarget, ref: string): Promise<PlanContent | null> {
  const parsed = parseRef(ref);
  if (parsed === null) return null;

  const absolute = await resolveRef(parsed, target);
  if (absolute === null) return null;

  try {
    const content = await readFile(absolute);
    const truncated = content.length > MAX_PLAN_BYTES;
    return {
      fileName: ref,
      text: content.subarray(0, MAX_PLAN_BYTES).toString('utf8'),
      truncated,
    };
  } catch {
    return null;
  }
}
