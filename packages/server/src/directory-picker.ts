/**
 * Elegir una carpeta del disco para abrir un proyecto nuevo.
 *
 * **El problema que resuelve.** Hasta el hito 18 no habia forma de empezar en
 * una carpeta que la app no conociera: la barra lista lo que esta en
 * `~/.claude/projects` —donde la CLI ya trabajo— mas el `defaultCwd`, que es
 * desde donde se lanzo el servidor. Una carpeta nueva no aparece en ninguna
 * lista y no hay por donde abrirla.
 *
 * **Es la unica parte de la app que lista fuera del `cwd` de una pestana**, asi
 * que se acota a lo minimo que hace falta para elegir una carpeta:
 *
 *  - **Solo nombres de directorio.** Ni archivos, ni tamanios, ni contenido, ni
 *    fechas. Para elegir una carpeta no hace falta nada mas.
 *  - **Las carpetas de las CLIs no se listan.** Con Claude Code, `~/.claude`: no
 *    hay razon para abrir un proyecto ahi y es la carpeta que la regla 2.1
 *    protege. La lista la declara cada adaptador (`protectedDirs`) y el
 *    selector la recibe hecha: no nombra ninguna CLI.
 *  - **El cliente nunca compone una ruta.** El selector guarda la ruta actual y
 *    el cliente solo nombra *un segmento de lo que el servidor le acaba de
 *    mostrar*, sube un nivel, o salta a una raiz. Un `pickerId` que no existe
 *    no lista nada. Es el criterio de CLAUDE.md 2.4 aplicado a un caso nuevo.
 *  - **Vive mientras vive el socket.** No hay estado que sobreviva a la
 *    conexion que lo pidio.
 *
 * Lo que devuelve termina en `terminal.open`, que ya recibia un `cwd` absoluto
 * del cliente y lo valida con un `stat`. O sea que abrir la pestana no cambia:
 * lo nuevo es de donde sale esa ruta.
 */

import { ServerTextError, serverText } from '@agent-workbench/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DirectoryPickerListing } from '@agent-workbench/shared';

/** Tope por nivel. Un directorio con miles de carpetas no se elige leyendolo. */
const MAX_ENTRIES = 500;

/** Cuantos selectores puede tener abiertos un socket a la vez. */
const MAX_PICKERS = 8;

/**
 * Directorios que no se listan nunca.
 *
 * `node_modules` y compania por ruido; `.git` porque adentro no hay proyectos.
 * La lista es la misma que salta el arbol de archivos, por coherencia.
 */
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'bin', 'obj', '$RECYCLE.BIN']);

/** Un pedido del selector que no se cumple. El texto va como clave (§6.23). */
export class DirectoryPickerError extends ServerTextError {}

/**
 * true si `target` es una de las carpetas protegidas o esta adentro. No se
 * listan ni se entran: regla 2.1.
 */
export function isInsideProtected(target: string, dirs: readonly string[]): boolean {
  const resolved = path.resolve(target);
  return dirs.some((dir) => {
    const protectedDir = path.resolve(dir);
    return resolved === protectedDir || resolved.startsWith(protectedDir + path.sep);
  });
}

/**
 * Las raices donde se puede saltar.
 *
 * En Windows, las unidades que de verdad existen: probarlas con un `stat` es
 * mas barato y mas honesto que pedirle la lista al sistema, y una unidad de red
 * caida simplemente no aparece.
 */
async function listRoots(): Promise<string[]> {
  const roots: string[] = [];
  const home = homedir();

  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const found = await Promise.all(
      letters.map(async (letter) => {
        const drive = `${letter}:\\`;
        try {
          await stat(drive);
          return drive;
        } catch {
          return null;
        }
      }),
    );
    roots.push(...found.filter((drive): drive is string => drive !== null));
  } else {
    roots.push('/');
  }

  if (!roots.includes(home)) roots.push(home);
  return roots;
}

interface Picker {
  id: string;
  current: string;
  /** Lo ultimo que se le listo. Es contra esto que se valida un `enter`. */
  entries: Set<string>;
}

export class DirectoryPickers {
  private readonly pickers = new Map<string, Picker>();
  private roots: string[] | null = null;

  /** `protectedDirs`: las carpetas de las CLIs registradas, instaladas o no. */
  constructor(private readonly protectedDirs: readonly string[]) {}

  /** Abre un selector en el directorio del usuario. */
  async open(): Promise<DirectoryPickerListing> {
    if (this.pickers.size >= MAX_PICKERS) {
      throw new DirectoryPickerError(serverText('pickerTooMany'));
    }
    const picker: Picker = { id: randomUUID(), current: homedir(), entries: new Set() };
    this.pickers.set(picker.id, picker);
    return this.listing(picker);
  }

  close(pickerId: string): void {
    this.pickers.delete(pickerId);
  }

  closeAll(): void {
    this.pickers.clear();
  }

  /** La ruta absoluta donde esta parado un selector, para abrir la pestana. */
  currentPath(pickerId: string): string | null {
    return this.pickers.get(pickerId)?.current ?? null;
  }

  /**
   * Entra en un subdirectorio, o sube con `..`.
   *
   * `name` tiene que ser **uno de los nombres que se acaban de listar**. No es
   * paranoia: es lo que hace que el cliente no pueda nombrar una ruta. Un
   * separador, un `..` incrustado o un nombre que no estaba en la lista se
   * rechazan antes de tocar el disco.
   */
  async enter(pickerId: string, name: string): Promise<DirectoryPickerListing> {
    const picker = this.require(pickerId);

    if (name === '..') {
      const parent = path.dirname(picker.current);
      // En una raiz, `dirname` devuelve la misma ruta: no hay a donde subir.
      if (parent !== picker.current) picker.current = parent;
      return this.listing(picker);
    }

    if (!picker.entries.has(name)) {
      throw new DirectoryPickerError(serverText('pickerNotListed'));
    }

    const target = path.join(picker.current, name);
    if (isInsideProtected(target, this.protectedDirs)) {
      throw new DirectoryPickerError(serverText('pickerCliFolder'));
    }
    picker.current = target;
    return this.listing(picker);
  }

  /** Salta a una de las raices, por posicion en la lista que se mando. */
  async root(pickerId: string, index: number): Promise<DirectoryPickerListing> {
    const picker = this.require(pickerId);
    const roots = await this.knownRoots();
    const target = roots[index];
    if (target === undefined) throw new DirectoryPickerError(serverText('pickerRootMissing'));
    picker.current = target;
    return this.listing(picker);
  }

  /**
   * Crea una subcarpeta y entra.
   *
   * El nombre lo escribe el usuario, asi que se valida como un segmento y nada
   * mas: sin separadores, sin `.` ni `..`, sin caracteres que Windows no acepta
   * en un nombre de archivo.
   */
  async create(pickerId: string, name: string): Promise<DirectoryPickerListing> {
    const picker = this.require(pickerId);
    const clean = name.trim();

    if (clean.length === 0 || clean.length > 120) {
      throw new DirectoryPickerError(serverText('pickerNameInvalid'));
    }
    if (clean === '.' || clean === '..') {
      throw new DirectoryPickerError(serverText('pickerNameInvalid'));
    }
    // Los que Windows no admite en un nombre de archivo. Los espacios y los
    // guiones si valen: `mi proyecto` y `agent-workbench` son normales.
    if (/[\\/:*?"<>|]/.test(clean)) {
      throw new DirectoryPickerError(serverText('pickerNameChars'));
    }
    for (const character of clean) {
      if ((character.codePointAt(0) ?? 0) < 32) {
        throw new DirectoryPickerError(serverText('pickerNameChars'));
      }
    }

    const target = path.join(picker.current, clean);
    if (isInsideProtected(target, this.protectedDirs)) {
      throw new DirectoryPickerError(serverText('pickerNoProjectsHere'));
    }

    try {
      // Sin `recursive`: si ya existe, se dice. Crear "la que ya estaba" en
      // silencio esconde un error de tipeo hasta que el proyecto sale vacio.
      await mkdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new DirectoryPickerError(
        code === 'EEXIST' ? serverText('pickerFolderExists') : serverText('pickerCreateFailed'),
      );
    }

    picker.current = target;
    return this.listing(picker);
  }

  private require(pickerId: string): Picker {
    const picker = this.pickers.get(pickerId);
    if (picker === undefined) throw new DirectoryPickerError(serverText('pickerClosed'));
    return picker;
  }

  private async knownRoots(): Promise<string[]> {
    this.roots ??= await listRoots();
    return this.roots;
  }

  /**
   * Lista el directorio actual y anota lo que se mando.
   *
   * Un directorio que no se puede leer —permisos, una unidad que se
   * desconecto— no es un error del selector: se devuelve vacio y el usuario
   * sube. Tirar el selector entero por una carpeta protegida seria peor.
   */
  private async listing(picker: Picker): Promise<DirectoryPickerListing> {
    const roots = await this.knownRoots();

    let names: string[] = [];
    let truncated = false;
    try {
      const found = await readdir(picker.current, { withFileTypes: true });
      const dirs = found
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !SKIPPED.has(name))
        .filter((name) => !isInsideProtected(path.join(picker.current, name), this.protectedDirs))
        .sort((a, b) => a.localeCompare(b));
      truncated = dirs.length > MAX_ENTRIES;
      names = dirs.slice(0, MAX_ENTRIES);
    } catch {
      // Ver arriba: vacio, no error.
    }

    picker.entries = new Set(names);

    return {
      pickerId: picker.id,
      path: picker.current,
      entries: names,
      roots,
      canGoUp: path.dirname(picker.current) !== picker.current,
      truncated,
    };
  }
}
