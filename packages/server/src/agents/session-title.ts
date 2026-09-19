/**
 * Como se lee el titulo de una sesion en la barra lateral, con cualquier CLI.
 *
 * Casi todos los titulos salen del primer mensaje del usuario (222 de 228
 * sesiones de Claude Code no tienen titulo propio, CLAUDE.md 4.7), y con Codex y
 * OpenCode pasa lo mismo. Una sola limpieza para todas: dos reglas distintas
 * harian que la misma barra se leyera distinto segun la CLI, y divergirian
 * solas.
 *
 * Vivia en `claude-code/session-scan.ts`; se movio sin cambios cuando hubo un
 * tercer consumidor (hito 26).
 */

import { pastedBlockPattern, pastedBoundaryPattern } from '@agent-workbench/shared';

/** Largo maximo de un titulo en la barra. */
export const TITLE_MAX_LENGTH = 90;

/** Lo que dice la barra de una sesion sin ningun texto que sirva de titulo. */
export const UNTITLED_SESSION_TITLE = 'Sesion sin titulo';

/**
 * Deja el texto en una linea legible.
 *
 * Como casi todos los titulos salen de aca, vale la pena: se sacan los saltos
 * de linea, los comandos de la CLI y las etiquetas de sistema que ensucian el
 * listado.
 */
export function toTitle(raw: string): string {
  let text = withoutPastedText(raw)
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > TITLE_MAX_LENGTH) {
    text = `${text.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * Lo escrito, sin los textos pegados desde el cuadro (hito 35, §6.24): el
 * titulo de una conversacion que empieza con un texto pegado es lo que se
 * pregunto, no las primeras lineas de lo pegado. Si no se escribio nada mas,
 * lo pegado, sin sus lineas de inicio y fin.
 */
function withoutPastedText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const typed = normalized.replace(pastedBlockPattern(), '$1');
  return typed.trim().length > 0 ? typed : normalized.replace(pastedBoundaryPattern(), ' ');
}
