/**
 * A qué proyecto y a qué rama pertenece una carpeta (hito 48, §6.38).
 *
 * Hasta el hito 48, una rama aparte salía en la barra como **otro proyecto**:
 * los proyectos se agrupan por carpeta exacta, y la carpeta de la rama es otra.
 * Con esto, una sesión de una rama aparte cae dentro de su proyecto, y una
 * pestaña toma su color y su lugar.
 *
 * De dónde sale el proyecto de una carpeta, en este orden:
 *
 *  1. del archivo `.git` de la carpeta, validado (`checkout.ts`), si existe;
 *  2. si ya no existe, del registro de la app (`worktrees.json`);
 *  3. y si la app no la creó, de la forma de su ruta (`names.ts`).
 *
 * Todo esto sólo agrupa y rotula. Lo que escribe en una carpeta principal lo
 * decide el registro, nunca esto.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionWorktree, TabWorktree } from '@agent-workbench/shared';
import { mainCwdFor, readCheckout } from './checkout.js';
import { branchCommit } from './git.js';
import { mainRootFromShape } from './names.js';
import type { WorktreeRecord } from './store.js';

/** Una carpeta del historial que es una rama aparte: dónde va su sesión, y con qué rama. */
export interface WorktreeLink {
  /** La carpeta del proyecto, con la misma subcarpeta que la sesión. */
  mainCwd: string;
  worktree: SessionWorktree;
}

export interface WorktreeRegistryView {
  byPath(folder: string): WorktreeRecord | null;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** El registro de una carpeta o de una de sus carpetas de arriba, con lo que queda por debajo. */
function recordAbove(
  registry: WorktreeRegistryView,
  cwd: string,
): { record: WorktreeRecord; inner: string } | null {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < 24; depth += 1) {
    const record = registry.byPath(current);
    if (record !== null) return { record, inner: path.relative(current, path.resolve(cwd)) };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export class WorktreeLinks {
  constructor(private readonly registry: WorktreeRegistryView) {}

  /** La rama aparte de una carpeta del historial, o null si es la de un proyecto (o no es de git). */
  async sessionLink(cwd: string): Promise<WorktreeLink | null> {
    if (cwd.length === 0) return null;
    if (await exists(cwd)) {
      const checkout = await readCheckout(cwd);
      if (checkout === null || !checkout.linked) return null;
      const record = this.registry.byPath(checkout.root);
      return {
        mainCwd: mainCwdFor(cwd, checkout),
        worktree: {
          branch: checkout.branch ?? record?.branch ?? path.basename(checkout.root),
          exists: true,
          reopenable: false,
        },
      };
    }

    const found = recordAbove(this.registry, cwd);
    if (found !== null) {
      const { record, inner } = found;
      return {
        mainCwd: inner.length === 0 ? record.mainRoot : path.join(record.mainRoot, inner),
        worktree: { branch: record.branch, exists: false, reopenable: await this.reopenable(record) },
      };
    }

    const mainRoot = mainRootFromShape(path.resolve(cwd));
    if (mainRoot === null) return null;
    return { mainCwd: mainRoot, worktree: { branch: path.basename(cwd), exists: false, reopenable: false } };
  }

  /**
   * Se puede volver a abrir una rama quitada si la creó la app, su carpeta no
   * está, la principal sí, y la rama sigue en el repo.
   */
  async reopenable(record: WorktreeRecord): Promise<boolean> {
    if (record.removedAt === null) return false;
    if ((await exists(record.path)) || !(await exists(record.mainRoot))) return false;
    try {
      return (await branchCommit(record.mainRoot, record.branch)) !== null;
    } catch {
      return false;
    }
  }

  /** true si la carpeta está en un repositorio de git. */
  async isGitRepo(cwd: string): Promise<boolean> {
    return cwd.length > 0 && (await readCheckout(cwd)) !== null;
  }

  /** La rama de la carpeta de una pestaña y su carpeta principal, o null fuera de git. */
  async tabWorktree(cwd: string): Promise<TabWorktree | null> {
    const checkout = await readCheckout(cwd);
    if (checkout === null) return null;
    return { mainCwd: mainCwdFor(cwd, checkout), branch: checkout.branch, linked: checkout.linked };
  }
}
