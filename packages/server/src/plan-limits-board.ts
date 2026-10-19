/**
 * Los limites del plan de todas las CLIs, para las ventanas (hito 47, §6.37).
 *
 * Junta la fuente de cada adaptador que la declara (`AgentAdapter.planLimits`)
 * y avisa cuando cambia alguna. Las fuentes que sondean una carpeta solo lo
 * hacen mientras haya al menos una ventana conectada: `retain` al conectar,
 * `release` al cerrar.
 *
 * No descarta las ventanas vencidas: eso depende de la hora a la que se miren,
 * y lo hace la web al dibujar.
 */

import type { AgentId, PlanLimits } from '@agent-workbench/shared';
import type { PlanLimitsSource } from './agents/adapter.js';

export interface PlanLimitsEntry {
  agent: AgentId;
  source: PlanLimitsSource;
}

export class PlanLimitsBoard {
  private readonly listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private holders = 0;

  /** `entries` se pide al retener: las CLIs encontradas ya se conocen para entonces. */
  constructor(private readonly entries: () => readonly PlanLimitsEntry[]) {}

  /** Lo de cada CLI que tiene al menos una ventana, en el orden de registro. */
  snapshot(): PlanLimits[] {
    return this.entries()
      .map(({ agent, source }) => ({ agent, windows: [...source.current()] }))
      .filter((limits) => limits.windows.length > 0);
  }

  /** Avisa cuando cambia lo de alguna CLI. Devuelve la desuscripcion. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Una ventana mas mirando: con la primera, las fuentes empiezan a escuchar. */
  retain(): void {
    this.holders += 1;
    if (this.holders > 1) return;
    this.stops = this.entries().map(({ source }) => source.subscribe(() => this.emit()));
  }

  /** Una ventana menos: con la ultima, dejan de sondear. */
  release(): void {
    if (this.holders === 0) return;
    this.holders -= 1;
    if (this.holders > 0) return;
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  dispose(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    this.holders = 0;
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[plan-limits] a listener failed:', error);
      }
    }
  }
}
