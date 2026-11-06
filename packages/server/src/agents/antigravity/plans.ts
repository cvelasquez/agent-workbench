/**
 * Los documentos markdown que una conversacion de Antigravity CLI escribio o nombro.
 *
 * Tres origenes:
 *  - `brain:<archivo>`: artefactos Markdown en `<appDataDir>/brain/<id>/*.md`
 *  - `scratch:<relativa>`: documentos en `<appDataDir>/brain/<id>/scratch/*.md`
 *  - `proj:<relativa>`: documentos Markdown dentro del proyecto (`cwd`)
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PlanContent, PlanOrigin, SessionPlan } from '@agent-workbench/shared';
import { resolveInside } from '../../path-guard.js';
import { describePlans, readPlan } from '../claude-code/plans-store.js';
import { sessionBrainDir, sessionScratchDir } from './paths.js';

const MAX_PLAN_BYTES = 256 * 1024;

export interface AntigravityPlanTarget {
  cwd: string;
  sessionId: string;
}

export function isMarkdownPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md');
}

/** Extrae referencias de planes de un texto (e.g. enlaces [name](path.md)) */
export function extractMarkdownLinks(text: string): string[] {
  if (text.length > 64_000) return [];
  const paths: string[] = [];
  const link = /\[[^\]\r\n]{1,256}\]\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^\s)])+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of text.matchAll(link)) {
    let destination = (match[1] ?? match[2] ?? '').replace(/\\([()\\])/g, '$1');
    try {
      destination = decodeURIComponent(destination);
    } catch {
      continue;
    }
    destination = destination.split(/[?#]/, 1)[0] ?? '';
    if (!destination.toLowerCase().endsWith('.md') || (/^[a-z][a-z0-9+.-]*:/i.test(destination) && !/^[a-z]:[\\/]/i.test(destination))) continue;
    paths.push(destination);
  }
  return paths;
}

/** Construye la ref opaca para una ruta de archivo dentro de un target. */
export function planRefFor(filePath: string, target: AntigravityPlanTarget): string | null {
  if (!isMarkdownPath(filePath)) return null;

  // Si ya tiene un prefijo de ref soportado
  if (filePath.startsWith('proj:') || filePath.startsWith('brain:') || filePath.startsWith('scratch:')) {
    return filePath;
  }

  const normalized = path.normalize(filePath);

  // Comprobar si esta dentro de brain/<sessionId>/scratch/
  const scratchDir = sessionScratchDir(target.sessionId);
  if (scratchDir !== null && normalized.toLowerCase().startsWith(scratchDir.toLowerCase())) {
    const rel = path.relative(scratchDir, normalized).split(path.sep).join('/');
    return `scratch:${rel}`;
  }

  // Comprobar si esta dentro de brain/<sessionId>/
  const brainDir = sessionBrainDir(target.sessionId);
  if (brainDir !== null && normalized.toLowerCase().startsWith(brainDir.toLowerCase())) {
    const rel = path.relative(brainDir, normalized).split(path.sep).join('/');
    return `brain:${rel}`;
  }

  // Comprobar si esta dentro del proyecto
  if (target.cwd.length > 0) {
    const rel = path.relative(target.cwd, normalized);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `proj:${rel.split(path.sep).join('/')}`;
    }
  }

  return null;
}

export async function describeAntigravityPlans(
  target: AntigravityPlanTarget,
  refs: readonly string[],
): Promise<SessionPlan[]> {
  const plans: SessionPlan[] = [];

  for (const ref of refs) {
    if (ref.startsWith('proj:')) {
      const [doc] = await describePlans(target, [ref]);
      if (doc !== undefined) plans.push(doc);
      continue;
    }

    let root: string | null = null;
    let relPath = '';
    let origin: PlanOrigin = 'scratch';

    if (ref.startsWith('brain:')) {
      root = sessionBrainDir(target.sessionId);
      relPath = ref.slice('brain:'.length);
      origin = 'cli-plans';
    } else if (ref.startsWith('scratch:')) {
      root = sessionScratchDir(target.sessionId);
      relPath = ref.slice('scratch:'.length);
      origin = 'scratch';
    }

    if (root === null || relPath.length === 0) continue;

    const plan: SessionPlan = {
      fileName: ref,
      title: path.basename(relPath, path.extname(relPath)),
      origin,
      path: relPath,
      absolutePath: path.join(root, relPath),
      exists: false,
      modifiedAt: 0,
      sizeBytes: 0,
    };

    try {
      const inside = await resolveInside(root, relPath);
      const info = await stat(inside);
      if (info.isFile()) {
        plan.exists = true;
        plan.modifiedAt = info.mtimeMs;
        plan.sizeBytes = info.size;
      }
    } catch {
      // No existe o fuera de root
    }

    plans.push(plan);
  }

  return plans;
}

export async function readAntigravityPlan(
  target: AntigravityPlanTarget,
  ref: string,
): Promise<PlanContent | null> {
  if (ref.startsWith('proj:')) {
    return readPlan(target, ref);
  }

  let root: string | null = null;
  let relPath = '';

  if (ref.startsWith('brain:')) {
    root = sessionBrainDir(target.sessionId);
    relPath = ref.slice('brain:'.length);
  } else if (ref.startsWith('scratch:')) {
    root = sessionScratchDir(target.sessionId);
    relPath = ref.slice('scratch:'.length);
  }

  if (root === null || relPath.length === 0) return null;

  try {
    const inside = await resolveInside(root, relPath);
    const content = await readFile(inside);
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

export function createAntigravityPlanSource(): {
  describe: (target: AntigravityPlanTarget, refs: readonly string[]) => Promise<SessionPlan[]>;
  read: (target: AntigravityPlanTarget, ref: string) => Promise<PlanContent | null>;
} {
  return {
    describe: describeAntigravityPlans,
    read: readAntigravityPlan,
  };
}
