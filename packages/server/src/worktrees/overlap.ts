/**
 * Qué archivos tocan dos o más ramas aparte (hito 49, §6.38). Puro.
 *
 * Es el aviso temprano de un equipo: dos agentes tocando lo mismo se ven antes
 * de integrar, no al integrar. Cada rama trae los archivos que cambió desde
 * que salió de su base (`branchChangedFiles`), con la ruta de antes en un
 * renombre: renombrar un archivo que otra rama edita también es tocarlo.
 */

import type { WorktreeChangedFile, WorktreeOverlap } from '@agent-workbench/shared';

export interface BranchFiles {
  branch: string;
  files: readonly WorktreeChangedFile[];
}

/** Las rutas que toca una rama: las de ahora y, en un renombre o una copia, las de antes. */
export function touchedPaths(files: readonly WorktreeChangedFile[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    if (file.oldPath !== null) paths.add(file.oldPath);
  }
  return paths;
}

/**
 * Los cambios sin commit de una carpeta que caen en archivos que la rama toca:
 * con alguno, `git merge --ff-only` se niega (medido en el plan). `git status`
 * resume una carpeta nueva en una sola entrada terminada en `/` (§6.2), que
 * toca todo lo que la rama trae debajo.
 */
export function pathsTouching(local: readonly string[], files: readonly WorktreeChangedFile[]): string[] {
  const touched = [...touchedPaths(files)];
  const set = new Set(touched);
  return local.filter((entry) => (entry.endsWith('/') ? touched.some((file) => file.startsWith(entry)) : set.has(entry)));
}

/**
 * Las otras ramas que tocan algo de `branch`, cada una con esos archivos (con
 * tope `max`) y cuántos son, en el orden de `all`. Vacío si no comparte nada.
 */
export function overlapsFor(branch: string, all: readonly BranchFiles[], max: number): WorktreeOverlap[] {
  const own = all.find((entry) => entry.branch === branch);
  if (own === undefined) return [];
  const mine = touchedPaths(own.files);
  if (mine.size === 0) return [];
  const overlaps: WorktreeOverlap[] = [];
  for (const other of all) {
    if (other.branch === branch) continue;
    const shared = [...touchedPaths(other.files)].filter((file) => mine.has(file)).sort((a, b) => a.localeCompare(b));
    if (shared.length > 0) overlaps.push({ branch: other.branch, files: shared.slice(0, max), fileCount: shared.length });
  }
  return overlaps;
}
