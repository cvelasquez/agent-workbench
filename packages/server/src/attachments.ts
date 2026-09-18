/**
 * Los archivos adjuntos del cuadro de escritura: como se llaman en disco y como
 * se le nombran a la CLI (hito 33, §6.21).
 *
 * Todo puro. Guardarlos es de `paste-store.ts`; mandarlos, del socket.
 *
 * Una imagen se acepta por su firma. Un documento no tiene una firma que
 * comprobar —un PDF, un .docx, un log y un CSV no comparten nada—, asi que la
 * regla es otra: **el nombre lo arma el servidor, y no se guarda nada que el
 * sistema ejecute con un doble clic**. El agente lee el archivo por su ruta;
 * nada de la app lo abre ni lo ejecuta.
 */

import type { TranscriptReferenceStyle } from './agents/adapter.js';
import { transcriptReferenceFor } from './handoff/transcript.js';

/** Hasta donde llega el nombre saneado, extension incluida. */
const MAX_NAME_CHARS = 60;

/** Hasta donde llega el nombre original dentro del mensaje. */
const MAX_DISPLAY_CHARS = 100;

/**
 * Lo que no se guarda. No es una lista de "formatos peligrosos": es lo que el
 * sistema ejecuta o carga sin preguntar. Un `.ps1`, un `.bat` o un `.js` son
 * texto que el agente puede tener que leer, y se abren con un editor.
 */
const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe', 'dll', 'msi', 'msp', 'scr', 'com', 'pif', 'cpl', 'sys', 'lnk', 'hta', 'jar', 'app', 'dmg',
]);

/**
 * Lo que una CLI con `at-quoted` sabe adjuntar sola: texto, y PDF. El resto
 * —un .docx, un .xlsx, un .zip— va como ruta entre comillas aunque la CLI
 * tenga `@`: adjuntado como texto seria basura, y nombrado por ruta el agente
 * elige con que abrirlo.
 */
const AT_ATTACHABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'log', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'html', 'htm', 'css',
  'yaml', 'yml', 'ini', 'conf', 'cfg', 'toml', 'sql', 'ps1', 'sh', 'bat', 'cmd',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'cs', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp',
  'pdf',
]);

/** La extension en minusculas, sin el punto; '' si no tiene una reconocible. */
export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match?.[1]?.toLowerCase() ?? '';
}

export function isBlockedExtension(name: string): boolean {
  return BLOCKED_EXTENSIONS.has(extensionOf(name));
}

/**
 * La pista del cliente convertida en algo que puede ir dentro de un nombre de
 * archivo: solo `[A-Za-z0-9._-]`, sin carpeta, sin punto inicial, hasta 60
 * caracteres conservando la extension. `archivo` si no queda nada.
 *
 * Sin espacios ni comillas a proposito: la ruta va a una linea de texto que
 * lee una CLI (§3.1).
 */
export function safeFileName(hint: string): string {
  // Lo que venga con forma de ruta pierde la carpeta: solo el ultimo tramo.
  const last = hint.split(/[\\/]/).pop() ?? '';
  const clean = last
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  if (clean.length === 0) return 'archivo';
  if (clean.length <= MAX_NAME_CHARS) return clean;

  const extension = extensionOf(clean);
  if (extension.length === 0) return clean.slice(0, MAX_NAME_CHARS);
  const stem = clean.slice(0, clean.length - extension.length - 1);
  return `${stem.slice(0, MAX_NAME_CHARS - extension.length - 1)}.${extension}`;
}

/** Como se nombra ese archivo a una CLI cuyo estilo es `style`. */
export function attachmentReference(filePath: string, style: TranscriptReferenceStyle): string {
  const effective: TranscriptReferenceStyle =
    style === 'at-quoted' && AT_ATTACHABLE_EXTENSIONS.has(extensionOf(filePath)) ? 'at-quoted' : 'quoted-path';
  return transcriptReferenceFor(filePath, effective);
}

export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * La linea del mensaje que presenta un adjunto. Dice el nombre original y el
 * peso para que el agente sepa que es antes de abrirlo.
 */
export function attachmentLine(originalName: string, bytes: number, reference: string): string {
  const display = Array.from(originalName)
    .map((char) => ((char.codePointAt(0) ?? 0) < 0x20 || char === '\u007f' || char === '"' ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_CHARS);
  const label = display.length > 0 ? display : 'sin nombre';
  return `Archivo adjunto (${label}, ${formatAttachmentBytes(bytes)}): ${reference}`;
}

/**
 * El texto que se manda: una linea por adjunto y despues lo que escribio el
 * usuario. Antes y no despues, como las imagenes: el recorte del envio corta
 * por el final, y un texto enorme no puede dejar un adjunto sin nombrar.
 */
export function textWithAttachments(text: string, lines: readonly string[]): string {
  return lines.length === 0 ? text : [...lines, text].filter((piece) => piece.trim().length > 0).join('\n');
}
