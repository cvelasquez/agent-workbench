/**
 * La copia propia en Markdown (hito 28, §8). Puro: no toca el disco.
 *
 * Es lo que se abre al hacer clic en una fila "copia" (D8) y lo que deja
 * "Exportar a Markdown". Se lee con cualquier visor, sin la app: por eso cada
 * cosa que el hilo dibuja como tarjeta aca es texto con una forma estable.
 *
 * Tres reglas que no se ven hasta que fallan:
 *
 *  - **Las cercas son de tildes y crecen con el contenido.** Un resultado de
 *    herramienta trae de todo, incluidas otras cercas: con un largo fijo, un
 *    ` ``` ` o un `~~~~` adentro cierra el bloque a mitad y el resto del
 *    documento se lee como Markdown. El largo es `max(4, racha mas larga + 1)`.
 *  - **Las fechas van en la hora local del servidor**, `dd-mm-aaaa hh:mm`: es
 *    la maquina del usuario, y el Markdown no tiene como convertirlas.
 *  - **Nada de lo que no se copio se inventa.** Una imagen sin asset dice que no
 *    se copio; el razonamiento no dice nada, porque el historial no lo tiene
 *    (CLAUDE.md 4.9).
 */

import {
  noticeText,
  type ConversationEvent,
  type ConversationPart,
  type VaultBodyLine,
  type VaultDocumentLine,
  type VaultHeader,
  type VaultImageRef,
} from '@agent-workbench/shared';
import { UNTITLED_SESSION_TITLE } from '../agents/session-title.js';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `dd-mm-aaaa hh:mm`, en hora local. */
export function formatLocalDateTime(ms: number): string {
  const date = new Date(ms);
  return `${formatLocalDay(ms)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `dd-mm-aaaa`, en hora local. */
export function formatLocalDay(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}-${date.getFullYear()}`;
}

/** `aaaa-mm-dd`, en hora local: ordena bien como nombre de archivo. */
export function formatFileDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

const formatTime = (ms: number): string => {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/** `50 s`, `1 min 50 s`, `2 h 5 min`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const rest = seconds % 60;
    return rest === 0 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 60)} min ${rest} s`;
  }
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes === 0 ? `${Math.floor(seconds / 3600)} h` : `${Math.floor(seconds / 3600)} h ${minutes} min`;
}

/**
 * Un bloque de codigo que el contenido no puede cerrar: cerca de tildes de
 * `max(4, racha mas larga de "~" + 1)`. Las comillas invertidas no cierran una
 * cerca de tildes, asi que no hace falta contarlas.
 */
export function fenced(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/~+/g)) longest = Math.max(longest, match[0].length);
  const fence = '~'.repeat(Math.max(4, longest + 1));
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `${fence}\n${body}${fence}`;
}

/** Codigo en linea con tantas comillas invertidas como hagan falta. */
function inlineCode(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const ticks = '`'.repeat(longest + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${ticks}${padded}${ticks}`;
}

/** Un titulo en una sola linea: un salto adentro partiria el encabezado. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** El texto de un enlace no puede traer corchetes sin escapar. */
const linkText = (text: string): string => oneLine(text).replace(/([\\[\]])/g, '\\$1');

/** Una frase de aviso con su punto final, sin duplicar el que ya traiga. */
const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

export interface SessionMarkdownOptions {
  /** Nombre para mostrar de la CLI (`AgentAdapter.label` o `IMPORTED_AGENT_LABELS`). */
  agentLabel: string;
  /** Enlace relativo al archivo donde quedara el Markdown, para un asset de la sesion. */
  assetLink(asset: string): string;
  /**
   * true si lo que se muestra salio de la copia. false: se leyo del historial
   * de la CLI para exportar, sin escribir la copia (§8.3), y la ficha no puede
   * decir "copiada".
   */
  fromCopy: boolean;
}

function renderPart(part: ConversationPart, image: VaultImageRef | undefined, imageNumber: number, options: SessionMarkdownOptions): string | null {
  switch (part.kind) {
    case 'text': {
      if (part.text.trim().length === 0) return null;
      return part.truncated ? `${part.text}\n\n_(recortado)_` : part.text;
    }
    case 'tool-call':
      return `**Herramienta ${inlineCode(part.name)}**${part.truncated ? ' (recortada)' : ''}\n\n${fenced(part.input)}`;
    case 'tool-result': {
      const marks = `${part.isError ? ' (error)' : ''}${part.truncated ? ' (recortado)' : ''}`;
      const blocks = [`**Resultado**${marks}`];
      if (part.text.length > 0) blocks.push(fenced(part.text));
      else if (part.imageCount === 0) blocks.push('_sin texto_');
      if (part.imageCount > 0) {
        blocks.push(`_${part.imageCount === 1 ? 'Una imagen' : `${part.imageCount} imágenes`} en el resultado, no copiadas._`);
      }
      return blocks.join('\n\n');
    }
    case 'question':
      return part.questions
        .map((item) => {
          const lines = [`**Pregunta:** ${oneLine(item.question)}`];
          if (item.options.length > 0) {
            lines.push('');
            for (const option of item.options) {
              const description = oneLine(option.description);
              lines.push(`- ${oneLine(option.label)}${description.length > 0 ? ` — ${description}` : ''}`);
            }
          }
          return lines.join('\n');
        })
        .join('\n\n');
    case 'thinking':
      return null;
    case 'image':
      return image?.asset !== null && image?.asset !== undefined
        ? `![imagen ${imageNumber}](<${options.assetLink(image.asset)}>)`
        : '_imagen no copiada_';
    case 'notice':
      return `> ${sentence(noticeText(part))}`;
  }
}

function renderEvent(event: ConversationEvent, images: readonly VaultImageRef[], previousDay: string | null, options: SessionMarkdownOptions): { text: string; day: string | null } | null {
  const blocks: string[] = [];
  let imageNumber = 0;
  for (const part of event.parts) {
    let image: VaultImageRef | undefined;
    if (part.kind === 'image') {
      image = images[imageNumber];
      imageNumber += 1;
    }
    const rendered = renderPart(part, image, imageNumber, options);
    if (rendered !== null) blocks.push(rendered);
  }
  // Un turno que solo razono no deja una seccion vacia con su hora.
  if (blocks.length === 0) return null;

  const day = event.at > 0 ? formatLocalDay(event.at) : null;
  const heading: string[] = [event.role === 'user' ? 'Usuario' : 'Asistente'];
  if (day !== null) {
    // El usuario lleva siempre la fecha; una respuesta del mismo dia, solo la hora.
    heading.push(event.role === 'user' || day !== previousDay ? formatLocalDateTime(event.at) : formatTime(event.at));
  }
  if (event.role === 'assistant') {
    if (event.model !== null && event.model.length > 0) heading.push(event.model);
    if (event.effort !== null && event.effort.length > 0) heading.push(event.effort);
    if (event.durationMs !== null) heading.push(formatDuration(event.durationMs));
  }
  if (event.queued) heading.push('enviado mientras trabajaba');

  return { text: `## ${heading.join(' · ')}\n\n${blocks.join('\n\n')}`, day: day ?? previousDay };
}

function renderDocument(document: VaultDocumentLine): string {
  const blocks = [`### ${oneLine(document.name)}`];
  if (document.modifiedAt !== null) blocks.push(`_Modificado el ${formatLocalDateTime(document.modifiedAt)}_`);
  blocks.push(document.text.trim().length > 0 ? document.text.replace(/\s+$/u, '') : '_vacío_');
  if (document.truncated) blocks.push('_(recortado)_');
  return blocks.join('\n\n');
}

/**
 * Una sesion de la copia en Markdown: la ficha, los eventos en orden y los
 * documentos al final. Las lineas pueden venir del cuerpo de la copia o armadas
 * desde una lectura del historial (con las imagenes sin asset).
 */
export function renderSessionMarkdown(
  header: VaultHeader,
  lines: Iterable<VaultBodyLine>,
  options: SessionMarkdownOptions,
): string {
  const title = oneLine(header.title);
  const out: string[] = [`# ${title.length > 0 ? title : UNTITLED_SESSION_TITLE}`];

  const facts = [
    `- CLI: ${options.agentLabel} · sesión ${inlineCode(header.sessionId)}`,
    `- Carpeta: ${header.cwd.length > 0 ? inlineCode(header.cwd) : 'desconocida'}`,
    header.createdAt !== null
      ? `- Del ${formatLocalDateTime(header.createdAt)} al ${formatLocalDateTime(header.updatedAt)}`
      : `- Última actividad: ${formatLocalDateTime(header.updatedAt)}`,
  ];
  if (header.source.kind === 'import') facts.push(`- Importada el ${formatLocalDateTime(header.source.importedAt)}`);
  else if (options.fromCopy) facts.push(`- Copiada el ${formatLocalDateTime(header.writtenAt)}`);
  else facts.push(`- Leída del historial de la CLI el ${formatLocalDateTime(header.writtenAt)}, sin pasar por la copia`);
  out.push(facts.join('\n'));

  if (header.partial) {
    const steps = header.stepCount !== null ? ` tenía ${header.stepCount} pasos y su contenido` : '';
    const documents = header.documentCount === 1 ? 'un documento' : `${header.documentCount} documentos`;
    out.push(
      `> Historial parcial: la conversación original${steps} no se puede leer.\n> Se conservan la ficha y ${documents}.`,
    );
  }

  out.push('---');

  const documents: VaultDocumentLine[] = [];
  let day: string | null = null;
  for (const line of lines) {
    if (line.kind === 'document') {
      documents.push(line);
      continue;
    }
    const rendered = renderEvent(line.event, line.images, day, options);
    if (rendered === null) continue;
    out.push(rendered.text);
    day = rendered.day;
  }

  if (documents.length > 0) {
    out.push('## Documentos');
    for (const document of documents) out.push(renderDocument(document));
  }

  return `${out.join('\n\n')}\n`;
}

export interface ProjectIndexEntry {
  updatedAt: number;
  agentLabel: string;
  title: string;
  /** Nombre del `.md` de la sesion, en la misma carpeta que el indice. */
  fileName: string;
  /** true si salio de la copia porque el historial de la CLI ya no la tiene. */
  onlyInCopy: boolean;
  partial: boolean;
}

export interface ProjectIndexInput {
  name: string;
  /** `''` si el proyecto no tiene carpeta conocida. */
  cwd: string;
  exportedAt: number;
  entries: readonly ProjectIndexEntry[];
  /** Sesiones del proyecto que no se pudieron exportar. */
  skipped: number;
}

/** El `index.md` de un proyecto exportado: la lista de sesiones, de la mas reciente a la mas vieja. */
export function renderProjectIndex(input: ProjectIndexInput): string {
  const out: string[] = [`# ${oneLine(input.name).length > 0 ? oneLine(input.name) : 'Proyecto'}`];
  const facts = [
    `- Carpeta: ${input.cwd.length > 0 ? inlineCode(input.cwd) : 'desconocida'}`,
    `- Exportado el ${formatLocalDateTime(input.exportedAt)}`,
    `- ${input.entries.length === 1 ? 'Una sesión' : `${input.entries.length} sesiones`}`,
  ];
  if (input.skipped > 0) {
    facts.push(`- ${input.skipped === 1 ? 'Una sesión no se pudo' : `${input.skipped} sesiones no se pudieron`} exportar`);
  }
  out.push(facts.join('\n'));

  const entries = [...input.entries].sort((a, b) => b.updatedAt - a.updatedAt);
  if (entries.length > 0) {
    out.push(
      entries
        .map((entry) => {
          const marks = `${entry.onlyInCopy ? ' · copia' : ''}${entry.partial ? ' · parcial' : ''}`;
          const title = oneLine(entry.title).length > 0 ? entry.title : UNTITLED_SESSION_TITLE;
          return `- ${formatLocalDateTime(entry.updatedAt)} · ${entry.agentLabel} · [${linkText(title)}](<${entry.fileName}>)${marks}`;
        })
        .join('\n'),
    );
  }
  return `${out.join('\n\n')}\n`;
}
