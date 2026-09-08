/**
 * Chequeo del camino que va del cuadro de escritura a la pty.
 *
 *   npx tsx scripts/check-composer-input.mjs [carpeta-temporal]
 *
 * Cubre las dos cosas del Hito 8 que fallan en silencio, las dos verificadas
 * antes contra la CLI real:
 *
 *  - **El armado del pegado.** Un `\r` que se cuele dentro de los delimitadores
 *    envia el mensaje partido en pedazos, uno por linea; un `ESC[201~` en el
 *    texto del usuario cierra el pegado a mitad y convierte el resto de su
 *    propio texto en teclas. Las dos cosas se ven como "la CLI hizo algo raro",
 *    nunca como un error.
 *  - **Que se acepta como imagen.** Es el unico sitio del servidor que escribe
 *    archivos con datos del cliente. Si se le cree al `mediaType` en vez de
 *    mirar los bytes, cualquier cosa aterriza en disco con nombre de imagen.
 *
 * Trabaja sobre una carpeta temporal propia.
 */

import { mkdir, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import {
  buildModeKeys,
  buildAnswerKeys,
  buildSubmission,
  fileReference,
  sanitizeForPaste,
} from '../src/pty-input.ts';
import { PasteImageError, PasteStore } from '../src/paste-store.ts';

const dir = process.argv[2] ?? path.join(process.cwd(), '.check-composer');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// Saneado del texto
// ---------------------------------------------------------------------------

check(
  'los saltos de linea se conservan',
  sanitizeForPaste('una\ndos\ntres') === 'una\ndos\ntres',
);

check(
  'CRLF pasa a LF — un \\r suelto adentro del pegado enviaria',
  sanitizeForPaste('una\r\ndos\rtres') === 'una\ndos\ntres',
);

check(
  'el cierre de pegado del usuario se quita',
  sanitizeForPaste('inocente\x1b[201~ls -la') === 'inocentels -la',
);

check(
  'la apertura de pegado tambien',
  sanitizeForPaste('\x1b[200~hola') === 'hola',
);

check(
  'otras secuencias de escape se quitan',
  sanitizeForPaste('rojo \x1b[31m y \x07 campana') === 'rojo [31m y  campana',
);

check('el tabulador sobrevive', sanitizeForPaste('a\tb') === 'a\tb');

check(
  'los acentos y emojis no se tocan',
  sanitizeForPaste('ñandú 🎉 año') === 'ñandú 🎉 año',
);

// ---------------------------------------------------------------------------
// Armado del envio
// ---------------------------------------------------------------------------

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const simple = buildSubmission('hola', []);
check(
  'el texto va dentro del pegado y el Enter fuera',
  simple === `${PASTE_START}hola${PASTE_END}\r`,
  JSON.stringify(simple),
);

const multi = buildSubmission('una\ndos', []);
check(
  'el multilinea no lleva ningun \\r adentro',
  multi.slice(0, -1).indexOf('\r') === -1 && multi.endsWith('\r'),
);

const withImage = buildSubmission('que ves?', [fileReference('C:\\tmp\\a b\\p.png')]);
check(
  'los adjuntos van primero y entrecomillados',
  withImage === `${PASTE_START}@"C:\\tmp\\a b\\p.png" que ves?${PASTE_END}\r`,
  JSON.stringify(withImage),
);

check(
  'una ruta con espacios va entre comillas — sin ellas la CLI corta en el espacio',
  fileReference('C:\\Users\\Jane Doe\\x.png') === '@"C:\\Users\\Jane Doe\\x.png"',
);

check('un cuadro vacio no manda nada', buildSubmission('   ', []) === null);
check('ni con saltos de linea sueltos', buildSubmission('\n\n', []) === null);

check(
  'solo una imagen, sin texto, si se manda',
  buildSubmission('', [fileReference('C:\\a.png')]) === `${PASTE_START}@"C:\\a.png"${PASTE_END}\r`,
);

check(
  'send:false deja el texto escrito y no envia',
  buildSubmission('hola', [], { send: false }) === `${PASTE_START}hola${PASTE_END}`,
);

// ---------------------------------------------------------------------------
// Imagenes: manda la firma, no el tipo declarado
// ---------------------------------------------------------------------------

const store = new PasteStore(path.join(dir, 'pasted'));

/** PNG minimo real: firma + IHDR + IEND. */
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.alloc(20),
]);

const saved = await store.save('term-1', 'image/png', PNG.toString('base64'));
check('un png real se guarda', saved.path.endsWith('.png') && saved.bytes === PNG.length);

let rejected = null;
try {
  await store.save('term-1', 'image/png', Buffer.from('esto no es un png').toString('base64'));
} catch (error) {
  rejected = error;
}
check(
  'un texto disfrazado de png se rechaza',
  rejected instanceof PasteImageError,
  rejected === null ? 'no lanzo' : rejected.message,
);

rejected = null;
try {
  await store.save('term-1', 'application/x-msdownload', PNG.toString('base64'));
} catch (error) {
  rejected = error;
}
check('un tipo no admitido se rechaza', rejected instanceof PasteImageError);

// La extension sale de la firma: un JPEG anunciado como png se guarda .jpg.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const asJpg = await store.save('term-1', 'image/png', JPEG.toString('base64'));
check(
  'la extension la decide el contenido, no lo que dijo el navegador',
  asJpg.path.endsWith('.jpg'),
  path.basename(asJpg.path),
);

// Un id de terminal con travesuras no puede escribir fuera de su carpeta.
const escaped = await store.save('../../fuera', 'image/png', PNG.toString('base64'));
check(
  'un id de terminal con .. no escapa de la carpeta de pegados',
  path.resolve(escaped.path).startsWith(path.resolve(path.join(dir, 'pasted'))),
  escaped.path,
);

// Borrado por pestana.
await store.clearTerminal('term-1');
const left = await readdir(path.join(dir, 'pasted'));
check('cerrar una pestana borra sus imagenes', !left.includes('term-1'), left.join(', '));

// Purga de lo viejo: una carpeta con fecha vieja se va, una de ahora se queda.
const stale = path.join(dir, 'pasted', 'vieja');
await mkdir(stale, { recursive: true });
await writeFile(path.join(stale, 'x.png'), PNG);
const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
await utimes(stale, old, old);
await store.save('reciente', 'image/png', PNG.toString('base64'));

await store.purgeStale();
const afterPurge = await readdir(path.join(dir, 'pasted'));
check('la purga borra lo de hace dos dias', !afterPurge.includes('vieja'));
check('y deja lo de ahora', afterPurge.includes('reciente'), afterPurge.join(', '));

// ---------------------------------------------------------------------------
// Modelo y esfuerzo: reconocer lo observado (hito 10)
// ---------------------------------------------------------------------------

const { modelOptionFor, modelCommand, effortCommand, MODEL_OPTIONS, modelOptionLabel, contextWindowFor } =
  await import('@agent-workbench/shared');

check(
  'claude-opus-5 -> Opus (200k)',
  modelOptionFor('claude-opus-5')?.value === 'opus',
  String(modelOptionFor('claude-opus-5')?.value),
);
check(
  'claude-opus-5[1m] -> Opus 1M — el sufijo manda sobre la familia',
  modelOptionFor('claude-opus-5[1m]')?.value === 'opus[1m]',
  String(modelOptionFor('claude-opus-5[1m]')?.value),
);
check(
  'un id con fecha se reconoce igual',
  modelOptionFor('claude-haiku-4-5-20251001')?.value === 'haiku',
  String(modelOptionFor('claude-haiku-4-5-20251001')?.value),
);
check('claude-sonnet-5 -> Sonnet', modelOptionFor('claude-sonnet-5')?.value === 'sonnet');
check('claude-fable-5-1[1m] -> Fable 1M', modelOptionFor('claude-fable-5-1[1m]')?.value === 'fable[1m]');
check(
  'un modelo desconocido no se fuerza a ninguna opcion',
  modelOptionFor('gpt-5.6-terra') === null,
);
check('sin modelo observado, no hay opcion', modelOptionFor(null) === null);
// La lista trae cada familia dos veces, una por ventana. Si las dos filas se
// leyeran igual, la lista pareceria traer el modelo repetido — que es
// exactamente la duda que provoco etiquetar la ventana en las dos.
const labels = MODEL_OPTIONS.map((option) => modelOptionLabel(option));
check(
  'ninguna opcion de la lista se lee igual que otra',
  new Set(labels).size === labels.length,
  labels.join(' | '),
);
check('la variante corta dice su ventana', labels.includes('Opus · 200k'), labels.join(' | '));
check('y la larga tambien', labels.includes('Opus · 1M'), labels.join(' | '));

// La ventana de la lista no puede contradecir a la que usa el medidor: son el
// mismo dato en dos pantallas, y verlas discrepar seria peor que no verlas.
for (const option of MODEL_OPTIONS) {
  if (!option.long) continue;
  check(
    `la ventana de ${option.value} coincide con la del medidor`,
    option.window === contextWindowFor(option.value),
    `${option.window} vs ${contextWindowFor(option.value)}`,
  );
}

check('los comandos se arman con su argumento', modelCommand('opus[1m]') === '/model opus[1m]');
check('y el de esfuerzo tambien', effortCommand('xhigh') === '/effort xhigh');

// ---------------------------------------------------------------------------
// Respuestas a una pregunta de eleccion
// ---------------------------------------------------------------------------
//
// Cada caso de aca es una secuencia que se probo contra la CLI 2.1.259,
// lanzandola en una pty y leyendo el `toolUseResult` que quedaba en el JSONL.
// Es lo unico del proyecto que escribe a ciegas en un TUI con estado: si estas
// reglas se desvian, no falla nada — se eligen otras opciones, o quedan
// numeros sueltos escritos en el prompt.

const unica = [{ multiSelect: false, optionCount: 3 }];
const dosPreguntas = [
  { multiSelect: false, optionCount: 3 },
  { multiSelect: false, optionCount: 2 },
];
const variasOpciones = [{ multiSelect: true, optionCount: 4 }];
const mixta = [
  { multiSelect: true, optionCount: 4 },
  { multiSelect: false, optionCount: 2 },
];

check(
  'una pregunta de opcion unica se responde con su numero, sin submit',
  buildAnswerKeys(unica, [[1]])?.join('') === '2',
  JSON.stringify(buildAnswerKeys(unica, [[1]])),
);

check(
  'dos preguntas: la CLI avanza sola, y al final va el submit',
  buildAnswerKeys(dosPreguntas, [[1], [0]])?.join('') === '211',
  JSON.stringify(buildAnswerKeys(dosPreguntas, [[1], [0]])),
);

check(
  'opcion multiple: marca, Tab para salir de la pregunta, y submit',
  buildAnswerKeys(variasOpciones, [[0, 2]])?.join('') === '13	1',
  JSON.stringify(buildAnswerKeys(variasOpciones, [[0, 2]])),
);

check(
  'multiple y unica en la misma llamada',
  buildAnswerKeys(mixta, [[0, 2], [1]])?.join('') === '13	21',
  JSON.stringify(buildAnswerKeys(mixta, [[0, 2], [1]])),
);

check(
  'las pulsaciones viajan sueltas — juntas en un write el menu no responde',
  buildAnswerKeys(mixta, [[0, 2], [1]])?.length === 5,
  JSON.stringify(buildAnswerKeys(mixta, [[0, 2], [1]])),
);

// Lo que sigue no se manda a medias: una secuencia incompleta deja el menu a
// mitad de camino y el resto de las teclas escritas en el prompt.
check('una pregunta sin responder no manda nada', buildAnswerKeys(dosPreguntas, [[0], []]) === null);
check('un indice fuera de rango no manda nada', buildAnswerKeys(unica, [[3]]) === null);
check('un indice negativo tampoco', buildAnswerKeys(unica, [[-1]]) === null);
check(
  'dos opciones en una pregunta de opcion unica no mandan nada',
  buildAnswerKeys(unica, [[0, 1]]) === null,
);
check(
  'una opcion repetida no manda nada — el segundo numero la desmarcaria',
  buildAnswerKeys(variasOpciones, [[1, 1]]) === null,
);
check(
  'menos respuestas que preguntas no manda nada',
  buildAnswerKeys(dosPreguntas, [[0]]) === null,
);
check(
  'una opcion mas alla de la novena no se puede teclear',
  buildAnswerKeys([{ multiSelect: false, optionCount: 12 }], [[9]]) === null,
);

// ---------------------------------------------------------------------------
// Respuestas escritas y modo de permiso (hito 16)
// ---------------------------------------------------------------------------
//
// Las dos cosas escriben teclas en un TUI con estado, que es lo unico del
// proyecto que no se puede deshacer. Todo lo de aca sale de medir contra la
// CLI 2.1.260, lanzandola en una pty y leyendo el `toolUseResult` del JSONL.

// La opcion `Type something` es la que sigue a las reales: con tres opciones,
// la cuarta. Despues va el texto pegado y el Enter que lo confirma.
const libreUnica = buildAnswerKeys(unica, [{ kind: 'free', text: 'otra cosa' }]);
check(
  'una respuesta escrita elige la opcion que sigue a las reales',
  libreUnica?.[0] === '4',
  JSON.stringify(libreUnica),
);
check(
  'el texto viaja como pegado, no tecleado',
  libreUnica?.[1] === '\x1b[200~otra cosa\x1b[201~',
  JSON.stringify(libreUnica?.[1]),
);
check('y lo confirma un Enter', libreUnica?.[2] === '\r');
check(
  'con una sola pregunta de opcion unica, el Enter ya envia',
  libreUnica?.length === 3,
  JSON.stringify(libreUnica),
);

// Con dos preguntas hace falta el `1` de "Submit answers", escriba el usuario
// en la primera o en la segunda. Medido en las dos posiciones.
const librePrimera = buildAnswerKeys(dosPreguntas, [{ kind: 'free', text: 'mi idea' }, [0]]);
check(
  'escribir en la primera de dos deja la segunda y el envio',
  JSON.stringify(librePrimera) ===
    JSON.stringify(['4', '\x1b[200~mi idea\x1b[201~', '\r', '1', '1']),
  JSON.stringify(librePrimera),
);

const libreUltima = buildAnswerKeys(dosPreguntas, [[1], { kind: 'free', text: 'mi idea' }]);
check(
  'escribir en la ultima de dos tambien termina con el envio',
  JSON.stringify(libreUltima) ===
    JSON.stringify(['2', '3', '\x1b[200~mi idea\x1b[201~', '\r', '1']),
  JSON.stringify(libreUltima),
);

// Una pregunta de opcion multiple sigue necesitando su Tab: el texto confirma
// la opcion, no cierra la pregunta.
const libreMultiple = buildAnswerKeys(variasOpciones, [{ kind: 'free', text: 'x' }]);
check(
  'en una de opcion multiple, el texto no reemplaza al Tab',
  libreMultiple?.includes('\t') === true,
  JSON.stringify(libreMultiple),
);

// El texto entra a un pegado, asi que se sanea igual que un mensaje: un
// delimitador de pegado adentro cerraria el pegado y el resto del texto
// entraria al menu como teclas.
const libreSucia = buildAnswerKeys(unica, [{ kind: 'free', text: 'malo\x1b[201~1234' }]);
check(
  'un delimitador de pegado dentro del texto se quita',
  libreSucia?.[1] === '\x1b[200~malo1234\x1b[201~',
  JSON.stringify(libreSucia?.[1]),
);
check(
  'un texto que queda vacio no manda nada',
  buildAnswerKeys(unica, [{ kind: 'free', text: '   ' }]) === null,
);
check(
  'con nueve o mas opciones, la de escribir tampoco se puede teclear',
  buildAnswerKeys([{ multiSelect: false, optionCount: 9 }], [{ kind: 'free', text: 'x' }]) === null,
);

// El modo de permiso: `shift+tab` cicla, asi que llegar a uno es contar
// pulsaciones. Ciclo medido: auto -> default -> acceptEdits -> plan -> auto.
const SHIFT_TAB = '\x1b[Z';
check(
  'de auto a plan son tres shift+tab',
  JSON.stringify(buildModeKeys('auto', 'plan')) ===
    JSON.stringify([SHIFT_TAB, SHIFT_TAB, SHIFT_TAB]),
  JSON.stringify(buildModeKeys('auto', 'plan')),
);
check(
  'de plan a auto es uno solo — el ciclo da la vuelta',
  JSON.stringify(buildModeKeys('plan', 'auto')) === JSON.stringify([SHIFT_TAB]),
  JSON.stringify(buildModeKeys('plan', 'auto')),
);
check('quedarse donde se esta no escribe nada', buildModeKeys('auto', 'auto')?.length === 0);
check(
  'un modo fuera del ciclo no se alcanza ciclando',
  buildModeKeys('auto', 'bypassPermissions') === null,
);
check(
  'y tampoco se sale de uno que no esta en el ciclo',
  buildModeKeys('bypassPermissions', 'plan') === null,
);

await rm(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
