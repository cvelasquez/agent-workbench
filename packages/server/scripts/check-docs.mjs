/**
 * Chequeo de la documentacion partida.
 *
 *   npx tsx scripts/check-docs.mjs
 *
 * `CLAUDE.md` se carga entero en cada sesion de Claude Code, asi que tiene las
 * reglas y el mapa; el detalle de cada CLI vive en `docs/ref-*.md`. Eso se
 * rompe en silencio de tres formas, y son las que cubre este chequeo:
 *
 *  - una seccion que se pierde o se duplica al mover texto de un archivo a
 *    otro (§11 en dos lados, o en ninguno);
 *  - una cita `§N.M` que apunta a una seccion que ya no existe — el codigo cita
 *    secciones en casi cien comentarios, y por eso **la numeracion no se
 *    renumera** aunque el texto cambie de archivo;
 *  - el indice de `CLAUDE.md` y la carpeta `docs/` que dejan de coincidir: un
 *    archivo de referencia que nadie nombra no lo lee nadie.
 *
 * Y un tope de tamano, que es el motivo de haberlo partido: sin el, el archivo
 * vuelve a crecer hito a hito hasta que arrancar una sesion cuesta 140k tokens.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(...).pathname` deja el espacio de "Agent Explorer" como %20.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCS = join(ROOT, 'docs');

// La guia interna no se versiona: en un clon del repositorio, o en el CI, no
// esta, y no hay nada que comprobar.
if (!existsSync(join(ROOT, 'CLAUDE.md')) || !existsSync(join(ROOT, 'CHECKLIST.md')) || !existsSync(DOCS)) {
  console.log('SKIP check-docs: the internal guide is not part of this checkout');
  process.exit(0);
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

/** Lineas de un Markdown, sin lo que esta dentro de un bloque de codigo. */
function outsideFences(text) {
  const out = [];
  let fence = false;
  for (const line of text.split('\n')) {
    const st = line.trim();
    if (st.startsWith('```') || st.startsWith('~~~')) {
      fence = !fence;
      continue;
    }
    if (!fence) out.push(line);
  }
  return out;
}

const refFiles = readdirSync(DOCS)
  .filter((n) => n.startsWith('ref-') && n.endsWith('.md'))
  .sort();

const docs = new Map([['CLAUDE.md', readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')]]);
for (const name of refFiles) docs.set(`docs/${name}`, readFileSync(join(DOCS, name), 'utf8'));

// ---- A. las quince secciones existen, y una sola vez ----------------------

/** Todos los encabezados numerados: `## 4.`, `### 4.9.2`, … */
const headings = new Map(); // "4.9.2" -> [archivo, …]
for (const [name, text] of docs) {
  for (const line of outsideFences(text)) {
    const m = /^#{2,4} (\d+(?:\.\d+)*)\.? /.exec(line);
    if (m) {
      const key = m[1];
      if (!headings.has(key)) headings.set(key, []);
      headings.get(key).push(name);
    }
  }
}

const top = [];
for (let n = 1; n <= 15; n++) top.push(String(n));
const faltan = top.filter((n) => !headings.has(n));
const repes = top.filter((n) => (headings.get(n) ?? []).length > 1);
check('A1 las secciones 1 a 15 existen', faltan.length === 0, faltan.join(', '));
check(
  'A2 ninguna seccion de primer nivel esta en dos archivos',
  repes.length === 0,
  repes.map((n) => `§${n}: ${headings.get(n).join(' + ')}`).join('; '),
);

// ---- B. toda cita § de la doc apunta a una seccion que existe --------------

const citasRotas = [];
for (const [name, text] of docs) {
  for (const line of outsideFences(text)) {
    for (const m of line.matchAll(/§\s?(\d+(?:\.\d+)*)/g)) {
      if (!headings.has(m[1])) citasRotas.push(`${name}: §${m[1]}`);
    }
  }
}
check(
  'B1 toda cita § de la doc existe como seccion',
  citasRotas.length === 0,
  [...new Set(citasRotas)].slice(0, 8).join(', '),
);

// ---- C. las citas del codigo siguen valiendo ------------------------------
// El codigo cita de dos formas: `CLAUDE.md 4.8.1` y `§5.5 de CLAUDE.md`. Las
// demas `§` del codigo son de la especificacion de su hito, no de esta doc.

function sources(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.vite') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, acc);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const codeRefs = [];
for (const file of sources(join(ROOT, 'packages'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/CLAUDE\.md\s+(\d+(?:\.\d+)*)/g)) codeRefs.push([file, m[1]]);
  for (const m of text.matchAll(/§(\d+(?:\.\d+)*) de\s+`?CLAUDE\.md/g)) codeRefs.push([file, m[1]]);
}
const codeRotas = codeRefs.filter(([, n]) => !headings.has(n));
check(
  `C1 las ${codeRefs.length} citas del codigo a CLAUDE.md siguen existiendo`,
  codeRotas.length === 0,
  codeRotas.slice(0, 5).map(([f, n]) => `${f.slice(ROOT.length)}: ${n}`).join(', '),
);

// ---- D. el indice y la carpeta docs/ dicen lo mismo ------------------------

const claude = docs.get('CLAUDE.md');
const nombrados = new Set([...claude.matchAll(/docs\/(ref-[a-z0-9-]+\.md)/g)].map((m) => m[1]));
const sinNombrar = refFiles.filter((n) => !nombrados.has(n));
const inexistentes = [...nombrados].filter((n) => !refFiles.includes(n));
check('D1 el indice nombra todos los docs/ref-*.md', sinNombrar.length === 0, sinNombrar.join(', '));
check('D2 el indice no nombra archivos que no existen', inexistentes.length === 0, inexistentes.join(', '));
check(
  'D3 cada archivo de referencia dice de que seccion es',
  refFiles.every((n) => /Parte de la guia del repositorio: contiene \*\*§/.test(docs.get(`docs/${n}`))),
);

// ---- E. el tope de tamano, que es el motivo de todo esto ------------------

const MAX_CHARS = 120_000;
const size = claude.length;
check(
  `E1 CLAUDE.md por debajo de ${MAX_CHARS.toLocaleString('es')} caracteres`,
  size <= MAX_CHARS,
  `${size.toLocaleString('es')} (~${Math.round(size / 3000)}k tokens). Si crecio, el detalle nuevo va a su docs/ref-*.md`,
);

// El CHECKLIST es lo vivo: pendientes y deuda. La cronica va a docs/bitacora.md.
const checklist = readFileSync(join(ROOT, 'CHECKLIST.md'), 'utf8');
check(
  'E2 CHECKLIST.md es la lista de pendientes, no la cronica',
  checklist.length <= 60_000,
  `${checklist.length.toLocaleString('es')} caracteres; la cronica va a docs/bitacora.md`,
);
check('E3 docs/bitacora.md existe', statSync(join(DOCS, 'bitacora.md')).isFile());

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
