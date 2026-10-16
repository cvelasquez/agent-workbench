/**
 * Lo que el dialogo de "volver a antes de este mensaje" muestra (hito 44,
 * §4.16), sin JSX: el chequeo lo importa y lo prueba.
 */

import type { ConversationEvent } from '@agent-workbench/shared';

/**
 * true si el evento es un mensaje que escribio el usuario: los unicos antes de
 * los que se puede volver. Un resultado de herramienta o un aviso no.
 */
export function isPromptEvent(event: ConversationEvent): boolean {
  if (event.role !== 'user') return false;
  if (event.parts.some((part) => part.kind === 'tool-result' || part.kind === 'notice')) return false;
  return event.parts.some((part) => part.kind === 'text' || part.kind === 'image');
}

/** Las herramientas de la CLI que cambian archivos y que su menu deshace. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** La ruta de una llamada a herramienta, aunque la entrada haya llegado recortada. */
function toolFilePath(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const value = parsed['file_path'] ?? parsed['notebook_path'];
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    // Recortada por el tope de transporte: se busca el campo a mano.
  }
  const match = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  if (match === null || match[1] === undefined) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

/** La ruta relativa a la carpeta de la pestana, si cae adentro. */
function relativeTo(cwd: string, file: string): string {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalize(cwd);
  const target = normalize(file);
  return base.length > 0 && target.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? file.slice(base.length + 1) : file;
}

/**
 * Los archivos que el agente cambio desde ese mensaje hasta el final, en el
 * orden en que los toco y sin repetir. Es lo que el menu de la CLI ofrece
 * deshacer; lo hecho por consola no esta, y el dialogo lo dice.
 */
export function changedFilesAfter(events: readonly ConversationEvent[], eventId: string, cwd: string): string[] {
  const index = events.findIndex((event) => event.eventId === eventId);
  if (index === -1) return [];
  const files: string[] = [];
  for (const event of events.slice(index)) {
    for (const part of event.parts) {
      if (part.kind !== 'tool-call' || !FILE_TOOLS.has(part.name)) continue;
      const file = toolFilePath(part.input);
      if (file === null) continue;
      const shown = relativeTo(cwd, file);
      if (!files.includes(shown)) files.push(shown);
    }
  }
  return files;
}

/** Lo que se cita del mensaje en el dialogo: sus primeras lineas. */
export function rewindPreview(event: ConversationEvent | undefined, maxLines = 6, maxChars = 400): string {
  if (event === undefined) return '';
  const text = event.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n').trim();
  const lines = text.split('\n');
  let preview = lines.slice(0, maxLines).join('\n');
  if (preview.length > maxChars) preview = preview.slice(0, maxChars);
  return preview.length < text.length ? `${preview.trimEnd()}…` : preview;
}
