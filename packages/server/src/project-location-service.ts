/**
 * Ubicar un proyecto que se movio de carpeta: vista previa, guardar y quitar
 * (Hito 56, §13.14).
 *
 * Es la logica de `location.preview`, `location.apply` y `location.remove`, sin
 * socket: el socket aporta la carpeta elegida (la de su selector) y guarda la
 * vista previa hasta que se confirma; aca se decide que se asocia a que y que
 * se rechaza. Nada nombra una ruta que venga del cliente (CLAUDE.md 2.4): el
 * proyecto va por su `key`, y las carpetas anteriores salen del indice.
 *
 * **Que se asocia.** Las carpetas del historial del proyecto que **no existen**
 * (`LocationPlacement.baseExists`): una por cada carpeta distinta donde corrieron
 * sus conversaciones, ya con la rama aparte resuelta a su principal. Cada una se
 * asocia a la carpeta elegida y cubre sus subcarpetas (`resolveLocation`).
 *
 *  - Ubicar el proyecto principal mueve tambien las subcarpetas con historial,
 *    que son otros proyectos de la barra: la vista previa lo cuenta.
 *  - Ubicar solo una subcarpeta (su proyecto sigue tachado en la carpeta nueva)
 *    crea una ubicacion mas especifica, que gana sobre la del proyecto.
 *  - **Reubicar no encadena.** El proyecto tachado porque su destino desaparecio
 *    sigue teniendo las mismas carpetas anteriores: se reemplazan sus
 *    ubicaciones, no se suma otra encima.
 *
 * **Confirmar rehace todo.** Entre ver y confirmar el disco pudo cambiar (la
 * carpeta anterior pudo volver a existir, el destino pudo borrarse), igual que
 * `memory.plan` y `memory.install`. Nada se guarda si algo no cierra, y no se
 * mueve ninguna pestana ni se redirige nada solo: si hay pestanas abiertas en
 * las carpetas anteriores, o mensajes en cola o programados en ellas, se pide
 * resolverlos antes.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  normalizeCwdKey,
  relativeUnder,
  serverText,
  type ProjectLocationPreview,
  type ProjectSummary,
  type TerminalDescriptor,
} from '@agent-workbench/shared';
import { isInsideProtected } from './directory-picker.js';
import { ProjectLocationError, makeLocation, resolveLocation, type ProjectLocationStore } from './project-locations.js';
import type { LocationPlacement } from './session-index.js';
import { isAbsoluteDir } from './settings-store.js';
import { isSameOrInside } from './vault/move.js';

/** Lo que el servicio necesita del resto del servidor. Inyectable para el chequeo. */
export interface ProjectLocationServiceDeps {
  index: {
    getProjects(): readonly ProjectSummary[];
    locationPlacements(): LocationPlacement[];
    refreshLocations(): Promise<void>;
  };
  store: Pick<ProjectLocationStore, 'list' | 'set' | 'remove'>;
  /** Las pestanas de ahora, vivas, dormidas o terminadas, con su carpeta. */
  tabs: () => ReadonlyArray<Pick<TerminalDescriptor, 'terminalId' | 'cwd'>>;
  /** true si la pestana tiene mensajes en cola o programados. */
  hasPending: (terminalId: string) => boolean;
  /** Las carpetas de las CLIs (`agents.protectedDirs()`): ahi no se asocia nada. */
  protectedDirs: () => readonly string[];
  platform: string;
  /** La carpeta del usuario: una ubicacion que parte de ella vale solo para ella. */
  homeDir?: string;
}

/** La vista previa sin su id: el id lo pone quien la guarda hasta que se confirma. */
export type ProjectLocationPlan = Omit<ProjectLocationPreview, 'previewId'>;

/**
 * La vista previa que una ventana tiene a la espera de confirmarse.
 *
 * El selector de carpetas se cierra al elegir y el cliente no puede nombrar una
 * ruta (CLAUDE.md 2.4), asi que la carpeta elegida queda aca, en el servidor y
 * en la conexion de esa ventana, bajo un id que el cliente devuelve al
 * confirmar. **Una sola a la vez**: una vista previa nueva reemplaza a la
 * anterior, y confirmar la gasta (si algo falla, se vuelve a elegir y a ver).
 * Un id que no es el de ahora no gasta la que esta esperando.
 */
export class PendingLocationPreview {
  private current: { previewId: string; projectKey: string; to: string } | null = null;

  constructor(private readonly newId: () => string = randomUUID) {}

  /** Guarda la carpeta elegida para ese proyecto y devuelve el id con el que se confirma. */
  hold(projectKey: string, to: string): string {
    const previewId = this.newId();
    this.current = { previewId, projectKey, to };
    return previewId;
  }

  /** Lo que se guardo bajo ese id, gastandolo; null si ya no es el de ahora. */
  take(previewId: string): { projectKey: string; to: string } | null {
    const current = this.current;
    if (current === null || current.previewId !== previewId) return null;
    this.current = null;
    return { projectKey: current.projectKey, to: current.to };
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export class ProjectLocationService {
  constructor(private readonly deps: ProjectLocationServiceDeps) {}

  /** Lo que pasaria si se asociara el proyecto a `to`, sin guardar nada. Lanza `ProjectLocationError` si no se puede. */
  async preview(projectKey: string, to: string): Promise<ProjectLocationPlan> {
    return this.plan(projectKey, to);
  }

  /**
   * Guarda la ubicacion: rehace la vista previa con el disco de ahora y, si
   * sigue valiendo y no hay pestanas ni envios pendientes en las carpetas
   * anteriores, la guarda y reemite la barra a todos.
   */
  async apply(projectKey: string, to: string): Promise<void> {
    const plan = await this.plan(projectKey, to);
    if (plan.pending > 0) throw new ProjectLocationError(serverText('locationPendingMessages', { count: plan.pending }));
    if (plan.tabs > 0) throw new ProjectLocationError(serverText('locationTabsOpen', { count: plan.tabs }));
    await this.deps.store.set(plan.from.map((from) => ({ from, to })));
    await this.deps.index.refreshLocations();
  }

  /**
   * Quita las ubicaciones que mueven a este proyecto, en pausa o aplicadas. El
   * historial queda donde estaba y no se borra nada.
   */
  async remove(projectKey: string): Promise<void> {
    const { index, store, platform } = this.deps;
    this.projectOf(projectKey);
    const keys = new Set<string>();
    for (const placement of index.locationPlacements()) {
      if (placement.projectKey === projectKey && placement.relocation !== null) {
        keys.add(normalizeCwdKey(placement.relocation.from, platform));
      }
    }
    if (keys.size === 0) throw new ProjectLocationError(serverText('locationNotMoved'));
    await store.remove([...keys]);
    await index.refreshLocations();
  }

  private projectOf(projectKey: string): ProjectSummary {
    const project = this.deps.index.getProjects().find((candidate) => candidate.key === projectKey);
    if (project === undefined) throw new ProjectLocationError(serverText('locationProjectGone'));
    return project;
  }

  private async plan(projectKey: string, to: string): Promise<ProjectLocationPlan> {
    const { index, store, platform } = this.deps;
    const home = this.deps.homeDir ?? homedir();
    const project = this.projectOf(projectKey);
    if (project.cwd.length === 0) throw new ProjectLocationError(serverText('locationNoFolder'));

    const placements = index.locationPlacements();

    // Las carpetas del historial de este proyecto que ya no estan: lo que se asocia.
    const origins = new Map<string, string>();
    for (const placement of placements) {
      if (placement.projectKey === projectKey && !placement.baseExists) {
        origins.set(normalizeCwdKey(placement.base, platform), placement.base);
      }
    }
    if (origins.size === 0) throw new ProjectLocationError(serverText('locationNothingToMove'));

    // El destino: una carpeta que existe y que no es de ninguna CLI.
    if (!isAbsoluteDir(to, platform)) throw new ProjectLocationError(serverText('locationDestinationInvalid', { path: to }));
    let isFolder = false;
    try {
      isFolder = (await stat(to)).isDirectory();
    } catch {
      isFolder = false;
    }
    if (!isFolder) throw new ProjectLocationError(serverText('locationDestinationInvalid', { path: to }));
    const protectedDirs = this.deps.protectedDirs();
    if (isInsideProtected(to, protectedDirs) || protectedDirs.some((dir) => isSameOrInside(to, dir, platform))) {
      throw new ProjectLocationError(serverText('locationDestinationProtected'));
    }

    // Una carpeta anterior que existe otra vez ya no necesita ubicarse: se mira ahora, no lo que el indice recordaba.
    for (const origin of origins.values()) {
      if (await pathExists(origin)) throw new ProjectLocationError(serverText('locationOriginExists', { path: origin }));
    }

    // La misma carpeta que ya tiene: nada que cambiar.
    const stored = store.list();
    const toKey = normalizeCwdKey(to, platform);
    const alreadyThere = [...origins.keys()].every((key) => {
      const location = stored.find((candidate) => candidate.fromKey === key);
      return location !== undefined && normalizeCwdKey(location.to, platform) === toKey;
    });
    if (alreadyThere) throw new ProjectLocationError(serverText('locationSameFolder'));

    // Que se moveria: se resuelve cada sesion contra las ubicaciones como quedarian.
    const originKeys = new Set(origins.keys());
    const hypothetical = [
      ...stored.filter((location) => !originKeys.has(location.fromKey)),
      ...[...origins.values()].map((from) => makeLocation(from, to, platform, 0)),
    ];
    let moving = 0;
    let inSubfolders = 0;
    const movingSessions = new Set<string>();
    for (const placement of placements) {
      if (placement.base.length === 0) continue;
      const resolved = resolveLocation(placement.base, hypothetical, platform, home);
      if (resolved === null || !originKeys.has(resolved.location.fromKey)) continue;
      moving += 1;
      if (resolved.rest.length > 0) inSubfolders += 1;
      movingSessions.add(`${placement.agent}:${placement.sessionId}`);
    }

    // Lo que la carpeta nueva ya tiene: lo propio y lo que otra ubicacion ya le trajo.
    let inDestination = 0;
    for (const placement of placements) {
      if (movingSessions.has(`${placement.agent}:${placement.sessionId}`)) continue;
      const effective = placement.relocation !== null && !placement.relocation.paused ? placement.relocation.cwd : placement.base;
      if (relativeUnder(effective, to, platform) !== null) inDestination += 1;
    }

    // Pestanas en las carpetas anteriores: vivas, dormidas o terminadas. Con una CLI no hay donde despertarlas.
    const folders = [...origins.values()];
    const tabs = this.deps.tabs().filter((tab) => folders.some((folder) => relativeUnder(tab.cwd, folder, platform) !== null));
    const pending = tabs.filter((tab) => this.deps.hasPending(tab.terminalId)).length;

    return {
      projectKey,
      from: folders,
      to,
      moving,
      inSubfolders,
      inDestination,
      tabs: tabs.length,
      pending,
    };
  }
}
