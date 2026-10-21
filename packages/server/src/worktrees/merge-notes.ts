/**
 * Juntar las dos versiones de una nota ignorada (21-10-2026, §6.38).
 *
 * Una nota que cambió en la rama y también en la carpeta principal se junta
 * como git junta el código: con la versión de cuando se copió a la rama (la
 * copia de origen, `note-bases.ts`) se sabe qué cambió cada lado, y se aplican
 * los dos. Sólo choca lo que los dos lados cambiaron en las mismas líneas.
 *
 * A diferencia de `git merge-file`, dos cambios pegados no chocan: en una nota,
 * alargar el último párrafo de un lado y agregar una sección justo debajo del
 * otro es lo normal. Es lo que pasó con la bitácora de la rama `fix/comp` del
 * usuario (medido el 21-10-2026): git la daba por choque. Y dos agregados en el
 * mismo lugar van los dos, primero el de la principal: así se juntan dos
 * entradas nuevas al final de una lista.
 *
 * Las líneas se comparan sin su fin de línea: una CLI que reescribe la nota
 * entera con `\n` donde había `\r\n` no la cambió, y lo que trae la rama toma
 * el fin de línea de la principal. El texto se lee como latin1, byte a byte, y
 * vuelve igual. Y juntar dos veces da lo mismo que una: un agregado de la rama
 * que la principal ya tiene no se repite.
 *
 * Puro: lo prueba `check-worktrees.mjs`.
 */

/** Un tramo de la versión de origen, [start, end), que pasa a ser `lines`. Con start === end, un agregado. */
export interface LineChange {
  start: number;
  end: number;
  lines: string[];
}

/**
 * Hasta cuántas líneas agregadas o quitadas se compara un lado contra el
 * origen: más que eso no es una nota que siguió creciendo, es otra, y se
 * pregunta. Con este tope el cálculo guarda unos 16 MB en el peor caso.
 */
export const MERGE_MAX_EDITS = 2_000;

/** Las líneas de un texto, cada una con su fin de línea (`\n` o `\r\n`). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Una línea sin su fin de línea: lo que se compara. */
function keyOf(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2);
  if (line.endsWith('\n')) return line.slice(0, -1);
  return line;
}

/**
 * Los pares de líneas iguales de `a` y `b`, en orden, por el algoritmo de
 * Myers. null si hacen falta más de `maxEdits` líneas agregadas o quitadas.
 */
function matchedPairs(a: readonly string[], b: readonly string[], maxEdits: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return n + m <= maxEdits ? [] : null;
  const limit = Math.min(n + m, maxEdits);
  // `v[offset + k]`: hasta dónde llega en `a` el mejor camino de la diagonal k.
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const at = (k: number): number => v[offset + k] ?? 0;
  // Lo que lee cada paso, para volver atrás después: la diagonal k del paso d en `[k + d + 1]`.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
      let i = down ? at(k + 1) : at(k - 1) + 1;
      let j = i - k;
      while (i < n && j < m && a[i] === b[j]) {
        i += 1;
        j += 1;
      }
      v[offset + k] = i;
      if (i >= n && j >= m) return backtrack(trace, n, m, d);
    }
  }
  return null;
}

/** Recorre el camino de Myers desde el final y junta los pares de líneas iguales. */
function backtrack(trace: readonly Int32Array[], n: number, m: number, depth: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  for (let d = depth; d > 0; d -= 1) {
    const snapshot = trace[d];
    const read = (k: number): number => snapshot?.[k + d + 1] ?? 0;
    const k = i - j;
    const down = k === -d || (k !== d && read(k - 1) < read(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousI = read(previousK);
    // Después del paso de edición, la diagonal: líneas iguales.
    const snakeStart = down ? previousI : previousI + 1;
    while (i > snakeStart) {
      i -= 1;
      j -= 1;
      pairs.push([i, j]);
    }
    i = previousI;
    j = previousI - previousK;
  }
  while (i > 0 && j > 0) {
    i -= 1;
    j -= 1;
    pairs.push([i, j]);
  }
  return pairs.reverse();
}

/**
 * Los tramos que cambian de `a` a `b`, en líneas de `a`. null si pasan del
 * tope. Lo igual al principio y al final no entra al cálculo: en una nota que
 * siguió creciendo es casi todo.
 */
export function lineChanges(a: readonly string[], b: readonly string[], maxEdits = MERGE_MAX_EDITS): LineChange[] | null {
  const keysA = a.map(keyOf);
  const keysB = b.map(keyOf);
  let head = 0;
  while (head < keysA.length && head < keysB.length && keysA[head] === keysB[head]) head += 1;
  let tail = 0;
  while (
    tail < keysA.length - head &&
    tail < keysB.length - head &&
    keysA[keysA.length - 1 - tail] === keysB[keysB.length - 1 - tail]
  ) {
    tail += 1;
  }
  const middleA = keysA.slice(head, keysA.length - tail);
  const middleB = keysB.slice(head, keysB.length - tail);
  const pairs = matchedPairs(middleA, middleB, maxEdits);
  if (pairs === null) return null;
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  for (const [pairI, pairJ] of [...pairs, [middleA.length, middleB.length] as [number, number]]) {
    if (pairI > i || pairJ > j) changes.push({ start: head + i, end: head + pairI, lines: b.slice(head + j, head + pairJ) });
    i = pairI + 1;
    j = pairJ + 1;
  }
  return changes;
}

function sameChange(a: LineChange, b: LineChange): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => keyOf(line) === keyOf(b.lines[index] ?? ''))
  );
}

/**
 * true si dos cambios de lados distintos tocan las mismas líneas del origen, o
 * si un agregado cae adentro de lo que el otro reemplazó. Pegados no chocan, y
 * dos agregados en el mismo lugar tampoco.
 */
function clash(ours: LineChange, theirs: LineChange): boolean {
  const oursAdds = ours.start === ours.end;
  const theirsAdds = theirs.start === theirs.end;
  if (oursAdds && theirsAdds) return false;
  if (oursAdds) return theirs.start < ours.start && ours.start < theirs.end;
  if (theirsAdds) return ours.start < theirs.start && theirs.start < ours.end;
  return ours.start < theirs.end && theirs.start < ours.end;
}

/**
 * true si un agregado de la rama ya está entero en un cambio de la principal
 * pegado a él, o en el mismo lugar: lo trajo una junta anterior que no llegó a
 * anotarse, o alguien a mano. Juntarlo otra vez lo repetiría (lo encontró la
 * revisión del 21-10-2026: la bitácora juntada dos veces repetía la sección).
 */
function absorbed(ours: LineChange, theirs: LineChange): boolean {
  if (theirs.start !== theirs.end || theirs.lines.length === 0) return false;
  if (theirs.start < ours.start || theirs.start > ours.end) return false;
  const haystack = ours.lines.map(keyOf);
  const needle = theirs.lines.map(keyOf);
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (needle.every((line, index) => haystack[at + index] === line)) return true;
  }
  return false;
}

/** Un cambio con su lado: 0, la principal; 1, la rama. */
export interface SidedChange {
  change: LineChange;
  side: 0 | 1;
}

/**
 * Los cambios de los dos lados en el orden en que se aplican, o null si
 * chocan. El mismo cambio en los dos lados va una vez, y un agregado de la
 * rama que la principal ya tiene no va. En el mismo lugar, el agregado va
 * antes que el reemplazo, y la principal antes que la rama.
 */
export function mergeChanges(mainChanges: readonly LineChange[], branchChanges: readonly LineChange[]): SidedChange[] | null {
  const fromBranch: LineChange[] = [];
  for (const theirs of branchChanges) {
    if (mainChanges.some((ours) => sameChange(ours, theirs) || absorbed(ours, theirs))) continue;
    if (mainChanges.some((ours) => clash(ours, theirs))) return null;
    fromBranch.push(theirs);
  }
  const rank = (change: LineChange): number => (change.start === change.end ? 0 : 1);
  const sided: SidedChange[] = [
    ...mainChanges.map((change): SidedChange => ({ change, side: 0 })),
    ...fromBranch.map((change): SidedChange => ({ change, side: 1 })),
  ];
  return sided.sort((p, q) => p.change.start - q.change.start || rank(p.change) - rank(q.change) || p.side - q.side);
}

/** El origen con los cambios aplicados. */
export function applyChanges(origin: readonly string[], changes: readonly LineChange[]): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const change of changes) {
    for (let index = cursor; index < change.start; index += 1) out.push(origin[index] ?? '');
    for (const line of change.lines) out.push(line);
    cursor = Math.max(cursor, change.end);
  }
  for (let index = cursor; index < origin.length; index += 1) out.push(origin[index] ?? '');
  return out;
}

/** El fin de línea de un texto si usa uno solo; null si los mezcla o no tiene. */
function endingOf(lines: readonly string[]): '\r\n' | '\n' | null {
  let crlf = 0;
  let lf = 0;
  for (const line of lines) {
    if (line.endsWith('\r\n')) crlf += 1;
    else if (line.endsWith('\n')) lf += 1;
  }
  if (crlf > 0 && lf === 0) return '\r\n';
  if (lf > 0 && crlf === 0) return '\n';
  return null;
}

/**
 * El origen con los cambios de los dos lados. Lo que la principal no cambió
 * sale de la principal y no del origen, y lo que trae la rama toma el fin de
 * línea de la principal si usa uno solo: si la principal pasó la nota a `\n`,
 * la junta no la devuelve a medias a `\r\n` (revisión del 21-10-2026).
 */
export function applyMerged(origin: readonly string[], main: readonly string[], changes: readonly SidedChange[]): string[] {
  const ending = endingOf(main);
  const out: string[] = [];
  let cursor = 0;
  // Una línea del origen que la principal no cambió está en la principal corrida por esto.
  let shift = 0;
  for (const { change, side } of changes) {
    for (let index = cursor; index < change.start; index += 1) out.push(main[index + shift] ?? origin[index] ?? '');
    for (const line of change.lines) {
      out.push(side === 0 || ending === null || !line.endsWith('\n') ? line : `${keyOf(line)}${ending}`);
    }
    if (side === 0) shift += change.lines.length - (change.end - change.start);
    cursor = Math.max(cursor, change.end);
  }
  for (let index = cursor; index < origin.length; index += 1) out.push(main[index + shift] ?? origin[index] ?? '');
  return out;
}

/** Las líneas de un texto, con la última terminada aunque no lo esté: si no, se pegaría a la que venga después. */
function workingLines(text: string): string[] {
  const lines = splitLines(text);
  const last = lines.length - 1;
  if (last >= 0 && !(lines[last] ?? '').endsWith('\n')) lines[last] = `${lines[last] ?? ''}${text.includes('\r\n') ? '\r\n' : '\n'}`;
  return lines;
}

/**
 * Las dos versiones de una nota juntas, desde la de origen; null si chocan o
 * si un lado cambió más de lo que se compara (`MERGE_MAX_EDITS`).
 */
export function mergeNote(base: Buffer, main: Buffer, branch: Buffer): Buffer | null {
  const [baseText, mainText, branchText] = [base, main, branch].map((content) => content.toString('latin1')) as [string, string, string];
  const origin = workingLines(baseText);
  const mainLines = workingLines(mainText);
  const mainChanges = lineChanges(origin, mainLines);
  const branchChanges = lineChanges(origin, workingLines(branchText));
  if (mainChanges === null || branchChanges === null) return null;
  const changes = mergeChanges(mainChanges, branchChanges);
  if (changes === null) return null;
  let merged = applyMerged(origin, mainLines, changes).join('');
  // Sin fin de línea al final sólo si ninguno de los dos lados lo tenía.
  if (!mainText.endsWith('\n') && !branchText.endsWith('\n')) merged = merged.replace(/\r?\n$/, '');
  return Buffer.from(merged, 'latin1');
}
