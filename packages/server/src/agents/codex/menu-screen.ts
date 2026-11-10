/**
 * Los menus de Codex, leidos de su pantalla emulada (09-11-2026, §10.23).
 *
 * Codex dibuja sus preguntas y aprobaciones como un menu numerado al pie de la
 * pantalla, con un titulo, unas lineas de contexto, las opciones y un pie fijo.
 * Medido con la 0.167 contra el Codex real y un proveedor falso:
 *
 * ```
 *   Would you like to run the following command?
 *
 *   Environment: local
 *   Reason: Prueba de menu
 *   $ mkdir probe-a
 *
 * › 1. Yes, proceed (y)
 *   2. Yes, and don't ask again for commands that start with `mkdir probe-a` (p)
 *   3. No, and tell Codex what to do differently (esc)
 *
 *   Press enter to confirm or esc to cancel
 * ```
 *
 * Lo que este lector resuelve, y el lector anterior no:
 *
 *  - **El ajuste de linea.** Codex parte el texto al ancho de su terminal, y la
 *    de la web de escritorio mide 74 columnas y la del telefono 45: la opcion 2
 *    de un comando ya se parte con `mkdir probe-a`. Aca un renglon que no
 *    empieza una opcion ni un campo continua al anterior.
 *  - **Las opciones en dos columnas** (etiqueta y descripcion), que al partirse
 *    mezclan las dos columnas en los mismos renglones: se cortan por la columna
 *    donde empieza la descripcion.
 *  - **El menu recortado.** Con la terminal baja, Codex deja de dibujar las
 *    ultimas opciones (a veces con una marca `↓`) o corta la ultima a la mitad.
 *    Se dice (`moreBelow`, y las opciones cortadas no aparecen) para que nadie
 *    lea de menos y se equivoque de boton.
 *  - **Los demas dialogos.** Cualquier pie conocido es un menu abierto, tenga
 *    tarjeta o no: lo que se escriba en la caja cae adentro del menu.
 *
 * Puro: recibe las lineas de la pantalla y no sabe de ptys, de la CLI ni de la
 * tarjeta. De la tarjeta se ocupa `question-screen.ts`, del estado
 * `screen-status.ts`.
 */

/** Las clases de menu que se reconocen por su titulo. `dialog` es cualquier otro con un pie conocido. */
export type CodexMenuKind = 'question' | 'command' | 'edits' | 'terminal-input' | 'mcp' | 'plan' | 'dialog';

/** El pie con que Codex cierra el menu. Cada familia dibuja el suyo. */
export type CodexMenuFooter = 'confirm' | 'go-back' | 'select' | 'submit' | 'question';

export interface CodexMenuOption {
  /** El numero que dibuja Codex, que tambien es la tecla que la elige. */
  readonly number: number;
  /** La etiqueta, con el ajuste de linea deshecho. En las aprobaciones termina en su atajo: `(y)`, `(esc)`. */
  readonly label: string;
  /** La segunda columna, si el menu la dibuja. Vacia si no. */
  readonly description: string;
}

export interface CodexMenu {
  readonly kind: CodexMenuKind;
  readonly footer: CodexMenuFooter;
  /** El titulo, ya junto. Vacio en un dialogo que no se reconoce. */
  readonly title: string;
  /** Lo que sigue al titulo, un renglon por campo (`Reason: ...`, `$ comando`). */
  readonly body: readonly string[];
  /** Las opciones que se ven. Vacias si el menu llega sin ninguna dibujada. */
  readonly options: readonly CodexMenuOption[];
  /** El numero de la opcion con la marca `›`, o 0 si no se ve ninguna. */
  readonly selected: number;
  /** Una marca `↓`: la lista sigue mas abajo de lo que cabe en la terminal. */
  readonly moreBelow: boolean;
  /** La primera opcion que se ve no es la 1, o hay una marca `↑`. */
  readonly moreAbove: boolean;
}

interface FooterRule {
  readonly footer: CodexMenuFooter;
  readonly test: RegExp;
}

/**
 * Los pies medidos. La pregunta del modelo trae `|` entre sus partes, y al
 * partirse el renglon Codex pierde el que cae en el corte.
 */
const FOOTERS: readonly FooterRule[] = [
  { footer: 'confirm', test: /^Press enter to confirm or esc to cancel$/ },
  { footer: 'go-back', test: /^Press enter to confirm or esc to go back$/ },
  { footer: 'select', test: /^enter select · esc back$/ },
  { footer: 'submit', test: /^enter to submit \| esc to cancel$/ },
  {
    footer: 'question',
    test: /^tab to add notes \| enter to submit (?:answer|all)(?: \|)? (?:←\/→ to navigate questions(?: \|)? )?esc to interrupt$/,
  },
];

interface TitleRule {
  readonly kind: CodexMenuKind;
  readonly test: RegExp;
}

/** Los titulos medidos. El de MCP es `Field N/M` y la pregunta va en el renglon siguiente. */
const TITLES: readonly TitleRule[] = [
  { kind: 'command', test: /^Would you like to run the following command\?$/ },
  { kind: 'edits', test: /^Would you like to make the following edits\?$/ },
  { kind: 'terminal-input', test: /^Would you like to send input to (?:terminal \S+|the existing terminal)\?$/ },
  { kind: 'plan', test: /^Implement this plan\?$/ },
  { kind: 'question', test: /^Question \d+\/\d+ \(\d+ unanswered\)$/ },
  { kind: 'mcp', test: /^Field \d+\/\d+(?: \(\d+ required unanswered\))?$/ },
];

/** Una opcion: la marca `›` si es la elegida, su numero y su texto. */
const OPTION_ROW = /^\s*(?:(›)\s+)?(\d{1,2})\.\s+(\S.*)$/;
/** Las marcas con que Codex avisa que la lista sigue arriba o abajo. */
const SCROLL_ROW = /^\s*[↑↓]\s*$/;
/** Un campo del cuerpo que empieza renglon propio: lo demas continua el anterior. */
const FIELD_ROW = /^(?:(?:Environment|Reason|Description|Destination|Input|Permission rule|Cwd|Command)(?::\s|:$)|\$ )/;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Junta dos renglones de un mismo texto que Codex partio por el ancho. Lo normal es un espacio, pero Codex
 * tambien corta despues de un guion o de una barra dentro de una palabra (`probe-` y `s1`, `packages/server/`
 * y `src`): ahi no habia espacio, y ponerlo cambiaria el nombre que se aprueba. Un token largo cortado sin
 * guion ni barra no se puede saber, y queda con el espacio.
 */
function joinWrapped(left: string, right: string): string {
  if (left === '') return right;
  if (right === '') return left;
  return /[A-Za-z0-9_.][-/\\]$/.test(left) && /^[A-Za-z0-9_.$]/.test(right) ? `${left}${right}` : `${left} ${right}`;
}

const foldWrapped = (rows: readonly string[]): string => rows.reduce((text, row) => joinWrapped(text, row.trim()), '');
const isBlank = (row: string | undefined): boolean => row === undefined || row.trim() === '';

interface FooterHit {
  readonly footer: CodexMenuFooter;
  /** El primer renglon del pie. */
  readonly index: number;
}

/**
 * El ultimo pie de la pantalla: uno a tres renglones seguidos que, juntos, son
 * un pie conocido. Puede no ser el ultimo renglon: un dialogo como el de acceso
 * completo no tapa la caja, que queda debajo.
 */
function footerIn(rows: readonly string[]): FooterHit | null {
  for (let end = rows.length; end > 0; end -= 1) {
    if (isBlank(rows[end - 1])) continue;
    for (let take = 1; take <= 3; take += 1) {
      const start = end - take;
      if (start < 0 || isBlank(rows[start])) break;
      const text = collapse(rows.slice(start, end).join(' '));
      const hit = FOOTERS.find((rule) => rule.test.test(text));
      if (hit !== undefined) return { footer: hit.footer, index: start };
    }
  }
  return null;
}

/**
 * true si la pantalla tiene un menu de Codex abierto: lo que se escriba cae
 * adentro, aunque la caja de abajo se vea libre.
 */
export function codexMenuOpen(lines: readonly string[]): boolean {
  return footerIn(lines.map((line) => line.replace(/\s+$/, ''))) !== null;
}

interface OptionBlock {
  readonly options: CodexMenuOption[];
  readonly selected: number;
  /** El renglon de la primera opcion que se ve, o -1. */
  readonly first: number;
  readonly moreBelow: boolean;
  readonly moreAbove: boolean;
}

const NO_OPTIONS: OptionBlock = { options: [], selected: 0, first: -1, moreBelow: false, moreAbove: false };

/** Las opciones que hay encima del pie, de la ultima a la 1 (o a la primera que se vea). */
function optionsAbove(rows: readonly string[], footerIndex: number): OptionBlock {
  let bottom = footerIndex - 1;
  let moreBelow = false;
  // Entre la ultima opcion y el pie puede haber un renglon en blanco o una marca.
  while (bottom >= 0 && (isBlank(rows[bottom]) || SCROLL_ROW.test(rows[bottom] ?? ''))) {
    if ((rows[bottom] ?? '').includes('↓')) moreBelow = true;
    bottom -= 1;
  }
  let first = -1;
  let moreAbove = false;
  for (let index = bottom; index >= 0; index -= 1) {
    const row = rows[index] ?? '';
    if (isBlank(row)) break;
    if (SCROLL_ROW.test(row)) {
      if (row.includes('↑')) moreAbove = true;
      continue;
    }
    const match = OPTION_ROW.exec(row);
    if (match === null) continue;
    first = index;
    if (Number(match[2]) === 1) break;
  }
  if (first < 0) return NO_OPTIONS;

  const options: CodexMenuOption[] = [];
  let selected = 0;
  let label = '';
  let description = '';
  let number = 0;
  // La columna donde empieza la descripcion en el primer renglon de la opcion.
  let descriptionColumn: number | null = null;
  const close = (): void => {
    if (number > 0) options.push({ number, label: collapse(label), description: collapse(description) });
  };
  for (let index = first; index <= bottom; index += 1) {
    const row = rows[index] ?? '';
    if (isBlank(row)) continue;
    if (SCROLL_ROW.test(row)) {
      if (row.includes('↑')) moreAbove = true;
      continue;
    }
    const match = OPTION_ROW.exec(row);
    if (match !== null) {
      close();
      number = Number(match[2]);
      if (match[1] !== undefined) selected = number;
      const text = match[3] ?? '';
      const startsAt = row.length - text.length;
      const gap = /\s{2,}(?=\S)/.exec(text);
      if (gap === null) {
        label = text;
        description = '';
        descriptionColumn = null;
      } else {
        label = text.slice(0, gap.index);
        description = text.slice(gap.index + gap[0].length);
        descriptionColumn = startsAt + gap.index + gap[0].length;
      }
      continue;
    }
    // Una continuacion: tiene que ir sangrada y despues de una opcion.
    if (number === 0 || !/^\s{3,}\S/.test(row)) return NO_OPTIONS;
    if (descriptionColumn === null) {
      label = joinWrapped(label, row.trim());
    } else {
      label = joinWrapped(label, row.slice(0, descriptionColumn).trim());
      description = joinWrapped(description, row.slice(descriptionColumn).trim());
    }
  }
  close();
  // La numeracion tiene que ser seguida: una lista que salta no es un menu.
  const firstNumber = options[0]?.number ?? 0;
  if (options.some((option, position) => option.number !== firstNumber + position)) return NO_OPTIONS;
  return {
    options,
    selected,
    first,
    moreBelow,
    moreAbove: moreAbove || firstNumber !== 1,
  };
}

/** Un titulo conocido al principio de un parrafo (puede ocupar hasta tres renglones). */
function titleAt(paragraph: readonly string[]): { kind: CodexMenuKind; rows: number } | null {
  for (let rows = 1; rows <= Math.min(3, paragraph.length); rows += 1) {
    const text = collapse(paragraph.slice(0, rows).join(' '));
    const hit = TITLES.find((rule) => rule.test.test(text));
    if (hit !== undefined) return { kind: hit.kind, rows };
  }
  return null;
}

/** Un parrafo del cuerpo en renglones logicos: cada campo empieza uno, lo demas continua el anterior. */
function logicalLines(rows: readonly string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const text = row.trim();
    if (text === '') continue;
    const last = out.length - 1;
    if (last < 0 || FIELD_ROW.test(text)) out.push(text);
    else out[last] = joinWrapped(out[last] ?? '', text);
  }
  return out;
}

interface Head {
  readonly kind: CodexMenuKind;
  readonly title: string;
  readonly body: string[];
}

const NO_HEAD: Head = { kind: 'dialog', title: '', body: [] };

/** El titulo y el cuerpo: los parrafos que hay encima de la primera opcion. */
function headAbove(rows: readonly string[], firstOption: number): Head {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (let index = Math.max(0, firstOption - 40); index < firstOption; index += 1) {
    const row = rows[index] ?? '';
    if (SCROLL_ROW.test(row)) continue;
    if (isBlank(row)) {
      if (current.length > 0) paragraphs.push(current);
      current = [];
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) paragraphs.push(current);

  for (let at = paragraphs.length - 1; at >= 0 && paragraphs.length - at <= 8; at -= 1) {
    const paragraph = paragraphs[at] ?? [];
    const found = titleAt(paragraph);
    if (found === null) continue;
    const title = collapse(paragraph.slice(0, found.rows).join(' '));
    const rest = paragraph.slice(found.rows);
    const later = paragraphs.slice(at + 1);
    const body: string[] = [];
    if (found.kind === 'question') {
      // El texto de la pregunta, entero y en un solo renglon.
      if (rest.length > 0) body.push(foldWrapped(rest));
    } else if (found.kind === 'mcp') {
      // La pregunta del servidor; los argumentos, uno por renglon.
      if (rest.length > 0) body.push(foldWrapped(rest));
      for (const paragraphRows of later) body.push(...paragraphRows.map((row) => row.trim()));
      return { kind: found.kind, title, body };
    } else {
      body.push(...logicalLines(rest));
    }
    for (const paragraphRows of later) body.push(...logicalLines(paragraphRows));
    return { kind: found.kind, title, body };
  }
  return NO_HEAD;
}

/**
 * El menu que tiene la pantalla, o null si no tiene ninguno. Con un pie
 * conocido siempre devuelve algo: de un titulo que no se reconoce o de opciones
 * que no se leen sale un `dialog` sin opciones, porque el menu esta abierto de
 * todas formas.
 */
export function parseCodexMenu(lines: readonly string[]): CodexMenu | null {
  const rows = lines.map((line) => line.replace(/\s+$/, ''));
  const footer = footerIn(rows);
  if (footer === null) return null;
  const block = optionsAbove(rows, footer.index);
  const head = block.first >= 0 ? headAbove(rows, block.first) : NO_HEAD;
  return {
    kind: head.kind,
    footer: footer.footer,
    title: head.title,
    body: head.body,
    options: block.options,
    selected: block.selected,
    moreBelow: block.moreBelow,
    moreAbove: block.moreAbove,
  };
}
