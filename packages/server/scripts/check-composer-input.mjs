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
 * Y desde el hito 33, dos mas:
 *
 *  - **Los archivos adjuntos** (§6.21). No tienen firma que comprobar, asi que
 *    lo que se cuida es el nombre: que una pista hostil no salga de la carpeta
 *    de la pestana, que un ejecutable no se guarde, y que la linea del mensaje
 *    nombre el archivo como lo lee cada CLI.
 *  - **El tamano de letra del hilo** (§6.22): el ciclo de tres pasos y lo que
 *    se acepta de `localStorage`. La web no tiene tests; se importa de aca.
 *
 * Y desde las mejoras de la 0.4.0: la ruta que el arbol de archivos pone en el
 * cuadro (§6.4), y la cookie donde van las preferencias de la ventana para que
 * sobrevivan a que la app arranque en otro puerto.
 *
 * Trabaja sobre una carpeta temporal propia.
 */

import { mkdir, readdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import {
  buildModeKeys,
  buildAnswerKeys,
  buildSubmission,
  fileReference,
  sanitizeForPaste,
} from '../src/pty-input.ts';
import { MAX_FILE_BYTES, PasteFileError, PasteImageError, PasteStore } from '../src/paste-store.ts';
import {
  attachmentLine,
  attachmentReference,
  safeFileName,
  textWithAttachments,
} from '../src/attachments.ts';
import { buildSubmissionWrites } from '../src/pty-input.ts';
import { toTitle } from '../src/agents/session-title.ts';
import { parseClientMessage } from '@agent-workbench/shared';
import {
  DEFAULT_THREAD_FONT_SIZE,
  nextThreadFontSize,
  parseThreadFontSize,
  threadFontTitle,
} from '../../web/src/thread-font.ts';
import {
  assembleMessage,
  insertPasteReference,
  insertPathAtCursor,
  nextPasteNumber,
  pasteEndLine,
  pasteReference,
  pasteStartLine,
  pastedChipLabel,
  pastedLineCount,
  referencedPasteNumbers,
  removePasteReferences,
  splitPastedBlocks,
} from '../../web/src/composer-paste.ts';
import { setLocale } from '../../web/src/i18n/index.ts';
import {
  PREFS_COOKIE,
  encodePrefsCookie,
  prefsCookieLine,
  readPrefsCookie,
} from '../../web/src/prefs-cookie.ts';
import { DEVICE_COOKIE, TOKEN_COOKIE } from '../src/security.ts';

// Los textos de la interfaz salen de `t()` (§6.23): este chequeo los compara
// con el español de siempre, así que lo fija antes de la primera comparación.
await setLocale('es');

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

// ---------------------------------------------------------------------------
// Archivos adjuntos (hito 33, §6.21)
// ---------------------------------------------------------------------------

check('un nombre normal queda, con los espacios como guion bajo', safeFileName('Informe final.docx') === 'Informe_final.docx', safeFileName('Informe final.docx'));
check('las tildes se van y la letra queda', safeFileName('año-señal.log') === 'ano-senal.log', safeFileName('año-señal.log'));
check('una ruta pierde la carpeta', safeFileName('..\\..\\Windows\\win.ini') === 'win.ini' && safeFileName('../../etc/passwd') === 'passwd');
check('sin punto inicial: `.env` no queda oculto', safeFileName('.env') === 'env', safeFileName('.env'));
check('solo puntos o nada: `archivo`', safeFileName('..') === 'archivo' && safeFileName('') === 'archivo' && safeFileName('¿?') === 'archivo');
check('comillas, & y | no pasan', /^[A-Za-z0-9._-]+$/.test(safeFileName('a"b&c|d`e$(x).txt')), safeFileName('a"b&c|d`e$(x).txt'));
{
  const long = safeFileName(`${'x'.repeat(200)}.pdf`);
  check('un nombre largo se corta a 60 y conserva la extension', long.length === 60 && long.endsWith('.pdf'), long);
}

{
  const store = new PasteStore(path.join(dir, 'adjuntos'));
  const content = Buffer.from('linea uno\nlinea dos\n', 'utf8');
  const saved = await store.saveAttachment('terminal-a', 'app server.log', content.toString('base64'));
  check('nombre adjunto-<n>-<8 hex>-<saneado>', /^adjunto-\d+-[0-9a-f]{8}-app_server\.log$/.test(saved.name), saved.name);
  check('cae en la carpeta de la pestana', path.dirname(saved.path) === path.join(dir, 'adjuntos', 'terminal-a'), saved.path);
  check('los bytes son los que llegaron', (await readFile(saved.path)).equals(content) && saved.bytes === content.length);

  // Binario: un PDF de mentira con un NUL adentro. No se toca ni se rechaza.
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2, 255]), Buffer.from('%%EOF')]);
  const savedPdf = await store.saveAttachment('terminal-a', 'manual.pdf', pdf.toString('base64'));
  check('un binario se guarda byte por byte', (await readFile(savedPdf.path)).equals(pdf));

  const hostile = await store.saveAttachment('../../fuera', '..\\..\\..\\fuera.txt', content.toString('base64'));
  check('ni la pestana ni el nombre sacan el archivo de la raiz',
    hostile.path.startsWith(path.join(dir, 'adjuntos') + path.sep) && path.basename(hostile.path).endsWith('-fuera.txt'), hostile.path);

  const reserved = await store.saveAttachment('terminal-a', 'CON', content.toString('base64'));
  check('un nombre reservado de Windows queda detras del prefijo', /^adjunto-\d+-[0-9a-f]{8}-CON$/.test(reserved.name), reserved.name);

  for (const name of ['setup.exe', 'x.DLL', 'acceso.lnk', 'raro.txt.exe']) {
    const error = await store.saveAttachment('terminal-a', name, content.toString('base64')).catch((e) => e);
    check(`un ejecutable no se guarda: ${name}`, error instanceof PasteFileError, String(error));
  }
  const script = await store.saveAttachment('terminal-a', 'deploy.ps1', content.toString('base64'));
  check('un script es texto y si se guarda', script.name.endsWith('-deploy.ps1'));

  const empty = await store.saveAttachment('terminal-a', 'vacio.txt', '').catch((e) => e);
  check('vacio se rechaza', empty instanceof PasteFileError);
  const big = await store
    .saveAttachment('terminal-a', 'grande.bin', Buffer.alloc(MAX_FILE_BYTES + 1, 65).toString('base64'))
    .catch((e) => e);
  check('pasado el tope se rechaza', big instanceof PasteFileError, String(big));
  const edge = await store.saveAttachment('terminal-a', 'tope.bin', Buffer.alloc(MAX_FILE_BYTES, 65).toString('base64'));
  check('justo en el tope se guarda', edge.bytes === MAX_FILE_BYTES);

  await store.clearTerminal('terminal-a');
  check('cerrar la pestana borra sus adjuntos', (await readdir(path.join(dir, 'adjuntos'))).includes('terminal-a') === false);
}

{
  const log = 'C:\\t\\adjunto-1-3f2a9c1b-app.log';
  const docx = 'C:\\t\\adjunto-2-3f2a9c1b-Informe_final.docx';
  check('texto con at-quoted: @"ruta"', attachmentReference(log, 'at-quoted') === `@"${log}"`);
  check('PDF con at-quoted: @"ruta"', attachmentReference('C:\\t\\a.PDF', 'at-quoted') === '@"C:\\t\\a.PDF"');
  check('un .docx va por ruta aunque la CLI tenga @', attachmentReference(docx, 'at-quoted') === `"${docx}"`);
  check('sin extension va por ruta', attachmentReference('C:\\t\\adjunto-1-ab-LICENSE', 'at-quoted') === '"C:\\t\\adjunto-1-ab-LICENSE"');
  check('quoted-path: siempre "ruta"', attachmentReference(log, 'quoted-path') === `"${log}"`);

  const line = attachmentLine('app "prod"\n.log', 219_000, `@"${log}"`);
  // En inglés, como todo lo que se le manda a una CLI en lenguaje natural (hito 35).
  check('la linea dice nombre, peso y referencia, sin comillas ni saltos en el nombre',
    line === `Attached file (app prod .log, 214 KB): @"${log}"`, line);
  check('sin nombre lo dice', attachmentLine('\n', 10, '"x"') === 'Attached file (unnamed, 10 B): "x"');

  check('sin adjuntos el texto es el de siempre', textWithAttachments('hola', []) === 'hola');
  check('los adjuntos van antes del texto, uno por linea', textWithAttachments('mira esto', [line, 'otra']) === `${line}\notra\nmira esto`);
  check('solo adjuntos: sin linea vacia al final', textWithAttachments('  ', [line]) === line);

  // Lo que llega a la pty con Claude Code: una pieza, el pegado entero y el Enter.
  const pieces = buildSubmissionWrites(textWithAttachments('mira esto', [line]), [], {
    imageReference: 'at-quoted', pasteMarkers: true,
  });
  check('una sola pieza, con la linea del adjunto adentro del pegado',
    pieces?.length === 1 && pieces[0] === `\x1b[200~${line}\nmira esto\x1b[201~\r`, JSON.stringify(pieces));
}

{
  const base = { type: 'agent.submit', terminalId: 't1', text: 'hola', images: [] };
  const plain = parseClientMessage(JSON.stringify(base));
  check('sin `files` el mensaje es el de siempre', plain !== null && !('files' in plain));
  const withFiles = parseClientMessage(JSON.stringify({ ...base, files: [{ name: 'a.log', data: 'QQ==' }] }));
  check('con `files` llegan nombre y datos', withFiles?.files?.[0]?.name === 'a.log' && withFiles.files[0].data === 'QQ==');
  check('un `files` vacio no agrega el campo', !('files' in (parseClientMessage(JSON.stringify({ ...base, files: [] })) ?? { files: 1 })));
  check('un adjunto mal formado invalida el mensaje', parseClientMessage(JSON.stringify({ ...base, files: [{ name: 'a.log' }] })) === null);
  check('y un `files` que no es lista', parseClientMessage(JSON.stringify({ ...base, files: 'a.log' })) === null);
}

// ---------------------------------------------------------------------------
// Tamano de letra del hilo (hito 33, §6.22)
// ---------------------------------------------------------------------------

check('por defecto, normal', DEFAULT_THREAD_FONT_SIZE === 'm');
check('el ciclo: chica → normal → grande → chica',
  nextThreadFontSize('s') === 'm' && nextThreadFontSize('m') === 'l' && nextThreadFontSize('l') === 's');
check('de lo guardado solo valen los tres', parseThreadFontSize('s') === 's' && parseThreadFontSize('m') === 'm'
  && parseThreadFontSize('l') === 'l' && parseThreadFontSize('xl') === null && parseThreadFontSize('') === null);
check('el titulo dice que hay y que pone el clic', threadFontTitle('m') === 'Tamaño de letra: normal (clic: grande)', threadFontTitle('m'));

// ---------------------------------------------------------------------------
// Texto pegado: número, marca y bloques (hito 35, §6.24)
// ---------------------------------------------------------------------------

{
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const show = (value) => JSON.stringify(value);

  // Lo que va a la CLI en lenguaje natural va en inglés, con cualquier idioma
  // de la interfaz (D1): el chequeo corre con la interfaz en español.
  check('las marcas van en inglés aunque la interfaz esté en español',
    pasteReference(1) === '[Pasted text #1]' && pasteStartLine(2) === '[Start of pasted text #2]' &&
    pasteEndLine(2) === '[End of pasted text #2]');
  check('la ficha sí va en el idioma de la interfaz',
    pastedChipLabel(1, 6) === '#1 · Texto pegado · 6 líneas' && pastedChipLabel(2, 1) === '#2 · Texto pegado · 1 línea',
    `${pastedChipLabel(1, 6)} | ${pastedChipLabel(2, 1)}`);
  check('la ficha vacía dice que no se manda', pastedChipLabel(3, 0) === '#3 · Texto pegado · vacío, no se manda', pastedChipLabel(3, 0));
  check('líneas: vacío 0, una 1, con salto final no cuenta de más',
    pastedLineCount('') === 0 && pastedLineCount('a') === 1 && pastedLineCount('a\nb\n') === 2 && pastedLineCount('a\r\nb') === 2);

  check('el primer número es 1 y el siguiente, uno más que el mayor en uso',
    nextPasteNumber([]) === 1 && nextPasteNumber([1]) === 2 && nextPasteNumber([3, 1]) === 4);
  check('las marcas que siguen en lo escrito también cuentan como en uso',
    same(referencedPasteNumbers('a [Pasted text #3] b [Pasted text #10] [Pasted text #3]'), [3, 10]) &&
      same(referencedPasteNumbers('sin marcas [Pasted text #] [pasted text #2]'), []),
    show(referencedPasteNumbers('a [Pasted text #3] b [Pasted text #10] [Pasted text #3]')));

  const insertion = (text, start, end, n) => insertPasteReference(text, start, end, n);
  const tail = insertion('aquí ', 5, 5, 1);
  check('al final, después de un espacio: la marca sola', tail.text === 'aquí [Pasted text #1]' && tail.caret === tail.text.length, show(tail));
  const glued = insertion('aquí', 4, 4, 2);
  check('pegado a una palabra: un espacio antes', glued.text === 'aquí [Pasted text #2]' && glued.inserted === ' [Pasted text #2]', show(glued));
  const middle = insertion('abcd', 2, 2, 1);
  check('en medio de una palabra: un espacio a cada lado y el cursor después',
    middle.text === 'ab [Pasted text #1] cd' && middle.caret === 'ab [Pasted text #1] '.length, show(middle));
  const punctuation = insertion('aquí, y', 4, 4, 1);
  check('antes de una coma: sin espacio después', punctuation.text === 'aquí [Pasted text #1], y', show(punctuation));
  const replaced = insertion('cambia ESTO por', 7, 11, 3);
  check('con texto seleccionado: la marca lo reemplaza', replaced.text === 'cambia [Pasted text #3] por', show(replaced));
  check('en un cuadro vacío: la marca sola', insertion('', 0, 0, 1).text === '[Pasted text #1]');
  check('después de un paréntesis que abre: sin espacio', insertion('(', 1, 1, 1).text === '([Pasted text #1]');

  check('quitar la marca deja un solo espacio', removePasteReferences('a [Pasted text #1] b', 1) === 'a b');
  check('al final y al principio, sin espacios sueltos',
    removePasteReferences('a [Pasted text #1]', 1) === 'a' && removePasteReferences('[Pasted text #1] b', 1) === 'b');
  check('todas las veces, y nunca la de otro número',
    removePasteReferences('[Pasted text #1] x [Pasted text #10] y [Pasted text #1]', 1) === 'x [Pasted text #10] y',
    removePasteReferences('[Pasted text #1] x [Pasted text #10] y [Pasted text #1]', 1));
  check('dos seguidas', removePasteReferences('a [Pasted text #1] [Pasted text #1] b', 1) === 'a b');

  const message = assembleMessage(
    [{ number: 1, text: 'uno\ndos\n' }, { number: 2, text: 'tres' }],
    'mira [Pasted text #1] y [Pasted text #2]',
  );
  const expected = [
    '[Start of pasted text #1]', 'uno', 'dos', '[End of pasted text #1]', '',
    '[Start of pasted text #2]', 'tres', '[End of pasted text #2]', '',
    'mira [Pasted text #1] y [Pasted text #2]',
  ].join('\n');
  check('el mensaje: cada texto entre su inicio y su fin, arriba, y lo escrito debajo', message === expected, show(message));
  check('un texto pegado vaciado no se manda, y su marca sale de lo escrito',
    assembleMessage([{ number: 1, text: '  \n' }, { number: 2, text: 'x' }], 'a [Pasted text #1] b [Pasted text #2]') ===
      '[Start of pasted text #2]\nx\n[End of pasted text #2]\n\na b [Pasted text #2]');
  check('sin nada escrito: solo los textos pegados',
    assembleMessage([{ number: 1, text: 'x' }], '  ') === '[Start of pasted text #1]\nx\n[End of pasted text #1]');
  check('sin textos pegados: lo escrito, como siempre', assembleMessage([], 'hola') === 'hola' && assembleMessage([], '   ') === '');
  check('los CRLF de un texto pegado pasan a LF',
    assembleMessage([{ number: 1, text: 'a\r\nb\r\n' }], '') === '[Start of pasted text #1]\na\nb\n[End of pasted text #1]');

  const roundTrip = [
    { kind: 'pasted', number: 1, text: 'uno\ndos', complete: true },
    { kind: 'pasted', number: 2, text: 'tres', complete: true },
    { kind: 'text', text: 'mira [Pasted text #1] y [Pasted text #2]' },
  ];
  check('ida y vuelta: el hilo recupera los textos pegados y lo escrito', same(splitPastedBlocks(message), roundTrip), show(splitPastedBlocks(message)));
  check('con los CRLF que puede guardar una CLI, lo mismo', same(splitPastedBlocks(message.replace(/\n/g, '\r\n')), roundTrip));
  check('sin textos pegados: el mensaje tal cual, sin tocar',
    same(splitPastedBlocks('hola\r\nchau'), [{ kind: 'text', text: 'hola\r\nchau' }]));
  const attached = attachmentLine('a.log', 1024, '"C:\\a.log"');
  const withAttachment = splitPastedBlocks(textWithAttachments(message, [attached]));
  check('la línea de un adjunto, que el servidor pone antes, queda en su lugar',
    same(withAttachment[0], { kind: 'text', text: attached }) && withAttachment.length === 4,
    show(withAttachment));
  check('un inicio sin su fin en un mensaje recortado: el bloque, incompleto',
    same(splitPastedBlocks('[Start of pasted text #1]\nmuy largo', true), [{ kind: 'pasted', number: 1, text: 'muy largo', complete: false }]));
  check('un inicio sin su fin, sin recorte: texto',
    same(splitPastedBlocks('[Start of pasted text #1]\nsuelto'), [{ kind: 'text', text: '[Start of pasted text #1]\nsuelto' }]));
  check('el fin de otro número no cierra el bloque',
    same(splitPastedBlocks('[Start of pasted text #1]\nx\n[End of pasted text #2]'), [{ kind: 'text', text: '[Start of pasted text #1]\nx\n[End of pasted text #2]' }]));
  check('una marca a mitad de línea no abre un bloque',
    same(splitPastedBlocks('ver [Start of pasted text #1]\nx\n[End of pasted text #1]').map((s) => s.kind), ['text']));

  // El título de la barra sale del primer mensaje, con las cuatro CLIs: es lo
  // que se preguntó, no las primeras líneas de lo pegado.
  check('el título de una sesión es lo escrito, sin los textos pegados',
    toTitle(message) === 'mira [Pasted text #1] y [Pasted text #2]', toTitle(message));
  check('y con los CRLF que puede guardar una CLI, lo mismo', toTitle(message.replace(/\n/g, '\r\n')) === 'mira [Pasted text #1] y [Pasted text #2]');
  check('sin nada escrito, el título es lo pegado, sin las líneas de inicio y fin',
    toTitle(assembleMessage([{ number: 1, text: 'uno\ndos' }], '')) === 'uno dos',
    toTitle(assembleMessage([{ number: 1, text: 'uno\ndos' }], '')));
  check('un mensaje sin textos pegados, como siempre', toTitle('  hola\n mundo ') === 'hola mundo');
}

// ---------------------------------------------------------------------------
// La ruta del árbol de archivos en el cuadro (§6.4)
// ---------------------------------------------------------------------------

{
  const show = (value) => JSON.stringify(value);
  const path = '"D:\\Mi App\\src\\a.ts"';
  const put = (text, start, end = start) => insertPathAtCursor(text, start, end, path);

  const empty = put('', 0);
  check('en un cuadro vacío: la ruta y un espacio para seguir escribiendo',
    empty.text === `${path} ` && empty.caret === empty.text.length, show(empty));
  check('al final, pegada a una palabra: un espacio antes', put('mira', 4).text === `mira ${path} `, show(put('mira', 4)));
  check('al final, después de un espacio: sin otro', put('mira ', 5).text === `mira ${path} `, show(put('mira ', 5)));
  const twice = insertPathAtCursor(empty.text, empty.caret, empty.caret, '"b"');
  check('dos rutas seguidas quedan separadas', twice.text === `${path} "b" `, show(twice));
  check('justo después de una comilla, también separadas', put('"a"', 3).text === `"a" ${path} `, show(put('"a"', 3)));
  const middle = put('abcd', 2);
  check('en medio de una palabra: un espacio a cada lado y el cursor después de la ruta',
    middle.text === `ab ${path} cd` && middle.caret === `ab ${path} `.length, show(middle));
  check('antes de un espacio: sin otro después', put('mira y', 4).text === `mira ${path} y`, show(put('mira y', 4)));
  check('antes de una coma: sin espacio después', put('mira, y', 4).text === `mira ${path}, y`, show(put('mira, y', 4)));
  check('entre paréntesis: sin espacios', put('()', 1).text === `(${path})`, show(put('()', 1)));
  check('con texto seleccionado: la ruta lo reemplaza', put('cambia ESTO por', 7, 11).text === `cambia ${path} por`,
    show(put('cambia ESTO por', 7, 11)));
  check('un cursor fuera del texto cae al final', put('ab', 99).text === `ab ${path} `, show(put('ab', 99)));
}

// ---------------------------------------------------------------------------
// Las preferencias de la ventana, en la cookie del equipo
// ---------------------------------------------------------------------------

{
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const show = (map) => JSON.stringify([...map]);
  const today = new Map([
    ['agent-workbench.locale', 'es'],
    ['agent-workbench.sound-volume', '0.35'],
    ['agent-workbench.sound', 'on'],
    ['agent-workbench.theme', 'dark'],
    ['agent-workbench.thread-font', 'l'],
    ['agent-workbench.panel-width', '640'],
    ['agent-workbench.files.hidden', 'true'],
    ['agent-workbench.notes-active', '3f2a9c1b-6519-41de-ac8e-2a2e6a94c4ce'],
  ]);
  const encoded = encodePrefsCookie(today);
  const header = `otra=1; ${PREFS_COOKIE}=${encoded}; ${TOKEN_COOKIE}=abc`;
  check('ida y vuelta: las preferencias de hoy vuelven iguales, entre otras cookies',
    encoded !== null && same(readPrefsCookie(header), today), show(readPrefsCookie(header)));
  check('el valor no trae nada que corte una cookie', encoded !== null && !/[;,\s]/.test(encoded));
  check('solo entran las claves de la app',
    same(readPrefsCookie(`${PREFS_COOKIE}=${encodePrefsCookie(new Map([['otra.clave', 'x'], ['agent-workbench.locale', 'es']]))}`),
      new Map([['agent-workbench.locale', 'es']])));
  check('sin la cookie, ninguna', readPrefsCookie('otra=1; y=2').size === 0 && readPrefsCookie('').size === 0);
  check('ilegible o con otra forma, ninguna',
    readPrefsCookie(`${PREFS_COOKIE}=%7Bno-json`).size === 0 &&
      readPrefsCookie(`${PREFS_COOKIE}=${encodeURIComponent('["es"]')}`).size === 0 &&
      readPrefsCookie(`${PREFS_COOKIE}=${encodeURIComponent('"es"')}`).size === 0);
  // Otra pagina de 127.0.0.1 puede escribirla: se leen solo claves y textos con forma.
  const hostile = readPrefsCookie(`${PREFS_COOKIE}=${encodeURIComponent(JSON.stringify({
    locale: 'es', __proto__x: 'a', 'Mayus': 'b', 'con espacio': 'c', volumen: 3, largo: 'x'.repeat(201),
  }))}`);
  check('de una cookie ajena, solo lo que tiene forma de preferencia', same(hostile, new Map([['agent-workbench.locale', 'es']])), show(hostile));
  const huge = new Map(Array.from({ length: 40 }, (_, i) => [`agent-workbench.clave-${i}`, 'x'.repeat(150)]));
  check('pasado el tope no se escribe: quedan en localStorage', encodePrefsCookie(huge) === null);
  const line = prefsCookieLine('abc');
  check('la línea: todo el equipo y cualquier puerto, 400 días, SameSite=Strict, legible desde la página',
    line === `${PREFS_COOKIE}=abc; Path=/; Max-Age=34560000; SameSite=Strict` && !/Domain|HttpOnly/i.test(line), line);
  check('no choca con las cookies del servidor', PREFS_COOKIE !== TOKEN_COOKIE && PREFS_COOKIE !== DEVICE_COOKIE);
}

await rm(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
