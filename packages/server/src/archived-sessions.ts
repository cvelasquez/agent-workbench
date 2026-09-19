/**
 * Sesiones archivadas.
 *
 * Archivar es **esconder de la lista, no borrar**. El `.jsonl` no es nuestro:
 * es de la CLI, es lo que usa `--resume`, y de `~/.claude/` solo leemos
 * (CLAUDE.md 2.1). Lo que molesta cuando el panel se llena de pruebas es el
 * ruido en la barra lateral, no los bytes en disco — y esconder es reversible,
 * borrar no.
 *
 * Por eso lo unico que se guarda aca es una lista de `sessionId`. El id alcanza
 * como clave sin el proyecto: es un UUID, unico en toda la instalacion.
 *
 * **Un id que ya no existe se conserva.** No se limpian los que no aparecen en
 * el indice: el indexado es asincrono y en frio tarda segundos, asi que una
 * purga al arrancar borraria justo lo que todavia no se leyo, y las sesiones
 * archivadas reapareceria solas. Una lista de UUIDs no le pesa a nadie.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appConfigDir, archivedSessionsPath } from './paths.js';

const STATE_VERSION = 1;
/** Espera antes de escribir. Archivar varias de una son varios cambios. */
const WRITE_DEBOUNCE_MS = 400;

function parseState(raw: string): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    // Una version que no conocemos se ignora entera: mejor la lista vacia que
    // interpretar mal un formato futuro y esconder lo que no corresponde.
    if (record['version'] !== STATE_VERSION) return null;
    const ids = record['sessionIds'];
    if (!Array.isArray(ids)) return null;
    return new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    return null;
  }
}

export class ArchivedSessions {
  private ids = new Set<string>();
  private writeTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  async load(): Promise<void> {
    try {
      const raw = await readFile(archivedSessionsPath(), 'utf8');
      this.ids = parseState(raw) ?? new Set();
    } catch {
      // Primer arranque, o archivo ilegible. Se empieza sin nada archivado.
      this.ids = new Set();
    }
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId);
  }

  /** Copia, para que nadie de afuera toque el conjunto vivo. */
  snapshot(): string[] {
    return [...this.ids];
  }

  /**
   * Archiva o restaura varias de una.
   *
   * Devuelve true si algo cambio de verdad. El indice reemite solo cuando lo
   * hay: archivar lo que ya estaba archivado no tiene por que repintar la
   * barra lateral entera.
   */
  set(sessionIds: readonly string[], archived: boolean): boolean {
    let changed = false;
    for (const sessionId of sessionIds) {
      if (sessionId.length === 0) continue;
      const had = this.ids.has(sessionId);
      if (archived === had) continue;
      if (archived) this.ids.add(sessionId);
      else this.ids.delete(sessionId);
      changed = true;
    }
    if (changed) this.schedule();
    return changed;
  }

  /** Escritura inmediata, para el apagado. */
  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.dirty) await this.writeNow();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.writeNow();
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  private async writeNow(): Promise<void> {
    this.dirty = false;
    try {
      await mkdir(appConfigDir(), { recursive: true });
      const target = archivedSessionsPath();
      // Escritura atomica, igual que el estado de las pestanas: un corte a
      // mitad no puede dejar media lista.
      const temporary = path.join(path.dirname(target), `archived.${process.pid}.tmp`);
      await writeFile(
        temporary,
        JSON.stringify({ version: STATE_VERSION, sessionIds: [...this.ids] }, null, 2),
        'utf8',
      );
      await rename(temporary, target);
    } catch (error) {
      console.warn("[archived] couldn't save the list:", error);
    }
  }
}
