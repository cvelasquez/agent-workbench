import type { AgentStatus, StatusSource } from '../adapter.js';
import { parseCodexMenu, type CodexMenu } from './menu-screen.js';

/**
 * Que espera el menu abierto. Las aprobaciones comparten el pie `Press enter to
 * confirm`, y la pregunta del modelo y el plan son preguntas; todo lo demas
 * (acceso completo, el sandbox de Windows, la lista de `/permissions`) es un
 * dialogo que solo se contesta en la solapa CLI.
 */
function waitingForMenu(menu: CodexMenu): string {
  switch (menu.kind) {
    case 'question':
    case 'plan':
      return 'input needed';
    case 'command':
    case 'edits':
    case 'terminal-input':
    case 'mcp':
      return 'permission prompt';
    default:
      if (menu.footer === 'question') return 'input needed';
      return menu.footer === 'confirm' ? 'permission prompt' : 'dialog open';
  }
}

/**
 * Se informa espera cuando la pantalla muestra el pie de un menu de Codex, con
 * las opciones a la vista o sin ellas: lo que se escriba cae adentro del menu.
 * El pie es lo unico que no se pierde cuando la terminal es baja o angosta
 * (§10.23). La caja que queda debajo de un dialogo no lo hace libre.
 */
export function codexScreenStatus(lines: readonly string[]): AgentStatus {
  const text = lines.join('\n');
  const menu = parseCodexMenu(lines);
  if (menu !== null) return { activity: 'waiting', waitingFor: waitingForMenu(menu) };
  if (/Approaching rate limits/i.test(text) && /Switch to/i.test(text)) {
    return { activity: 'waiting', waitingFor: 'dialog open' };
  }
  if (/esc to interrupt|Waiting for startup|esc cancel/i.test(text)) return { activity: 'busy', waitingFor: null };
  // Al escribir, Codex sustituye el pie de atajos por modelo y carpeta. La
  // opcion marcada de un menu (`› 1. ...`) no es la caja.
  const composer = lines.findIndex((line) => /^\s*›(?:\s|$)/.test(line) && !/^\s*›\s+\d+\.\s/.test(line));
  if (composer >= 0 && lines.slice(composer + 1).some((line) =>
    /\? for shortcuts/.test(line) || /^\s*\S.*\s·\s(?:[A-Za-z]:[\\/]|\/|~(?:[\\/]|$))/.test(line),
  )) return { activity: 'idle', waitingFor: null };
  return { activity: 'unknown', waitingFor: null };
}

export class CodexScreenStatus implements StatusSource {
  private readonly states = new Map<string, AgentStatus>();
  private readonly screens = new Map<string, AgentStatus>();
  private readonly openTurns = new Set<string>();
  private readonly readers = new Map<string, () => Promise<void>>();
  private readonly listeners = new Map<string, Set<(status: AgentStatus | null) => void>>();
  subscribe(id: string, listener: (status: AgentStatus | null) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    listener(this.states.get(id) ?? { activity: 'unknown', waitingFor: null });
    return () => { listeners.delete(listener); if (listeners.size === 0) this.listeners.delete(id); };
  }
  set(id: string, status: AgentStatus): void {
    if (!id) return;
    this.screens.set(id, status);
    this.publish(id);
  }
  setTurnOpen(id: string, open: boolean): void {
    if (!id) return;
    if (open) this.openTurns.add(id);
    else this.openTurns.delete(id);
    this.publish(id);
  }
  private publish(id: string): void {
    const screen = this.screens.get(id) ?? { activity: 'unknown', waitingFor: null };
    const status = screen.activity === 'waiting' || screen.activity === 'busy'
      ? screen
      : this.openTurns.has(id) ? { activity: 'busy' as const, waitingFor: null } : screen;
    const previous = this.states.get(id);
    if (previous?.activity === status.activity && previous.waitingFor === status.waitingFor) return;
    this.states.set(id, status);
    for (const listener of this.listeners.get(id) ?? []) listener(status);
  }
  attach(id: string, reader: () => Promise<void>): void { if (id) this.readers.set(id, reader); }
  async refresh(id: string): Promise<void> { await this.readers.get(id)?.(); }
  remove(id: string): void { this.states.delete(id); this.screens.delete(id); this.openTurns.delete(id); this.readers.delete(id); }
  waitUntilReady(): Promise<boolean> { return Promise.resolve(false); }
  dispose(): void { this.states.clear(); this.screens.clear(); this.openTurns.clear(); this.readers.clear(); this.listeners.clear(); }
}
