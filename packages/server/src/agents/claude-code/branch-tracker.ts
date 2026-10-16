/**
 * Que lineas del archivo de sesion siguen siendo la conversacion, y cuales
 * quedaron en una rama que la CLI abandono (hito 44, §4.16).
 *
 * El JSONL de Claude Code es un arbol: cada linea trae su `uuid` y el de la que
 * cuelga (`parentUuid`). La CLI no borra nada. Cuando se deshace un mensaje (se
 * lo detiene antes de que el agente haga algo, o se vuelve a antes de el con el
 * menu de rewind), lo que se manda despues cuelga de **antes** de el, y lo
 * deshecho queda como una rama muerta. Medido con la 2.1.301 en
 * `docs/herramientas/claude-rewind/`.
 *
 * Lo que **no** es una rama abandonada, medido sobre las 91 524 lineas del
 * historial de la maquina donde se escribio esto:
 *
 *  - El resultado de una herramienta cuelga de **su** llamada, no de la linea
 *    anterior: con varias en paralelo, el arbol se abre en cada una (unos 6 000
 *    casos). Por eso una rama sin ningun mensaje del usuario no se esconde nunca.
 *  - `/compact` empieza con `parentUuid` null y el padre de verdad en
 *    `logicalParentUuid` (25 casos). Quien llama pasa ese como padre.
 *
 * La regla: se ve el camino desde la ultima linea hasta la raiz, mas toda rama
 * que salga de ese camino **sin** mensajes del usuario. Una rama con un mensaje
 * del usuario que quedo fuera del camino es lo que alguien deshizo.
 *
 * Se recalcula solo cuando puede cambiar: llega una linea del usuario que no
 * cuelga de la anterior (la unica forma en que la CLI empezo una rama en las
 * mediciones), o se esconde algo que la CLI deshizo y todavia no escribio
 * (`withdraw`). Puro: lo prueba `check-prompt-editing.mjs`.
 */

/** Una linea de la cadena principal (las de subagentes, `isSidechain`, no entran). */
export interface BranchLine {
  uuid: string;
  /** `parentUuid`, o `logicalParentUuid` si el primero es null. */
  parent: string | null;
  /** Un mensaje del usuario: lo que hace que una rama abandonada se esconda. */
  prompt: boolean;
  /**
   * Una linea que puede empezar una rama: una del usuario que no es el
   * resultado de una herramienta. Las demas, aunque no cuelguen de la
   * anterior, no recalculan nada.
   */
  mayBranch: boolean;
  /**
   * Una linea del asistente o del usuario: lo que la CLI escribe cuando de
   * verdad sigue con un mensaje. Un adjunto o un aviso del arnes no.
   */
  speaks: boolean;
}

interface BranchNode {
  parent: string | null;
  prompt: boolean;
}

export class BranchTracker {
  private readonly nodes = new Map<string, BranchNode>();
  /** La ultima linea que llego. */
  private last: string | null = null;
  /**
   * El mensaje desde el que se escondio lo que la CLI deshizo sin escribirlo,
   * o null. Mientras este, la conversacion termina en su padre.
   */
  private withdrawn: string | null = null;
  private hidden: ReadonlySet<string> = new Set();

  /** Una linea nueva. true si cambio lo que se ve. */
  observe(line: BranchLine): boolean {
    if (this.nodes.has(line.uuid)) return false;
    this.nodes.set(line.uuid, { parent: line.parent, prompt: line.prompt });
    const previous = this.last;
    this.last = line.uuid;
    if (this.withdrawn !== null) {
      /*
        Un adjunto del mensaje retirado que llega tarde no dice nada: la CLI
        escribe sus lineas en tandas, y las de ese mensaje pueden caer despues
        de que la app lo escondio (medido en la prueba en vivo). Solo cuenta
        que siga hablando en esa rama, o que escriba en otra.
      */
      if (!line.speaks && this.descendsFrom(line.uuid, this.withdrawn)) return this.recompute();
      // Lo que la CLI escribe despues de deshacer manda: lo escondido a mano se
      // olvida, y la rama nueva dice que queda afuera.
      this.withdrawn = null;
      return this.recompute();
    }
    if (line.mayBranch && previous !== null && line.parent !== previous) return this.recompute();
    return false;
  }

  /**
   * Esconde desde ese mensaje en adelante: la CLI lo deshizo y todavia no
   * escribio nada que lo diga. Solo un mensaje del usuario que esta en la
   * conversacion que se ve. true si cambio lo que se ve.
   */
  withdraw(uuid: string): boolean {
    const node = this.nodes.get(uuid);
    if (node === undefined || !node.prompt || this.withdrawn === uuid) return false;
    if (!this.pathFrom(this.leaf()).has(uuid)) return false;
    this.withdrawn = uuid;
    return this.recompute();
  }

  /** El mensaje desde el que se escondio, mientras la CLI no escriba otra cosa. */
  withdrawnFrom(): string | null {
    return this.withdrawn;
  }

  isHidden(uuid: string): boolean {
    return this.hidden.has(uuid);
  }

  /** Cuantas lineas se esconden. Para el chequeo. */
  hiddenCount(): number {
    return this.hidden.size;
  }

  /** El archivo encogio o se reemplazo. */
  reset(): void {
    this.nodes.clear();
    this.last = null;
    this.withdrawn = null;
    this.hidden = new Set();
  }

  /** Donde termina la conversacion que se ve. */
  private leaf(): string | null {
    if (this.withdrawn === null) return this.last;
    return this.nodes.get(this.withdrawn)?.parent ?? null;
  }

  /** true si `uuid` es `ancestor` o cuelga de el. */
  private descendsFrom(uuid: string, ancestor: string): boolean {
    return this.pathFrom(uuid).has(ancestor);
  }

  /** La linea y todas las de las que cuelga. */
  private pathFrom(leaf: string | null): Set<string> {
    const path = new Set<string>();
    let current = leaf;
    while (current !== null && !path.has(current)) {
      const node = this.nodes.get(current);
      if (node === undefined) break;
      path.add(current);
      current = node.parent;
    }
    return path;
  }

  private recompute(): boolean {
    const path = this.pathFrom(this.leaf());

    // Un padre que no esta en el archivo hace de raiz: no se encontro ninguno
    // en las mediciones, y asi una linea suelta no tira abajo nada.
    const children = new Map<string | null, string[]>();
    for (const [uuid, node] of this.nodes) {
      const key = node.parent !== null && this.nodes.has(node.parent) ? node.parent : null;
      const list = children.get(key);
      if (list === undefined) children.set(key, [uuid]);
      else list.push(uuid);
    }

    // Las ramas que salen del camino, y las raices que no son la suya.
    const roots: string[] = [];
    for (const uuid of children.get(null) ?? []) if (!path.has(uuid)) roots.push(uuid);
    for (const uuid of path) {
      for (const child of children.get(uuid) ?? []) if (!path.has(child)) roots.push(child);
    }

    const hidden = new Set<string>();
    for (const root of roots) {
      const subtree: string[] = [];
      const pending = [root];
      let hasPrompt = false;
      while (pending.length > 0) {
        const uuid = pending.pop() as string;
        subtree.push(uuid);
        if (this.nodes.get(uuid)?.prompt === true) hasPrompt = true;
        for (const child of children.get(uuid) ?? []) pending.push(child);
      }
      if (hasPrompt) for (const uuid of subtree) hidden.add(uuid);
    }

    const changed = hidden.size !== this.hidden.size || [...hidden].some((uuid) => !this.hidden.has(uuid));
    this.hidden = hidden;
    return changed;
  }
}
