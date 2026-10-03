/**
 * Lo que la ventana de Ajustes cambia del servidor (Hito 41, §6.32): con que
 * consola abre una nueva, y que CLIs no se usan.
 *
 *  - **La consola vale enseguida** para las que se abran desde ahora; las
 *    abiertas siguen con la suya. Una elegida que no esta instalada no se
 *    acepta: se elige de las que el servidor encontro, por id.
 *  - **Las CLIs apagadas valen al reiniciar.** Apagar una en caliente obligaria
 *    a soltar su historial, sus vigilantes y su lugar en la barra con la app
 *    andando; se guarda, y Ajustes dice que falta reiniciar mientras lo
 *    guardado y lo que corre no coincidan (`disabledAtStart`).
 */

import { EventEmitter } from 'node:events';
import type { AgentId, AppSettingsChange, AppSettingsStatus, ConsoleShellId } from '@agent-workbench/shared';
import type { AgentRegistry } from './agents/registry.js';
import type { SettingsStore } from './settings-store.js';
import { pickShell, type ShellCandidate, type ShellLocation } from './shell-locator.js';

export interface AppSettingsServiceOptions {
  settings: SettingsStore;
  agents: Pick<AgentRegistry, 'disabledIds'>;
  /** Las consolas instaladas, del arranque. */
  shells: readonly ShellCandidate[];
  /** A quien avisar que cambio la consola de las nuevas: el registro de terminales. */
  onShellChange: (shell: ShellLocation | null) => void;
}

/** Por que no se acepto un cambio. Lo traduce el socket. */
export class AppSettingsChangeError extends Error {
  constructor(readonly reason: 'shell-not-installed') {
    super(reason);
  }
}

export class AppSettingsService extends EventEmitter {
  private readonly disabledAtStart: AgentId[];

  constructor(private readonly options: AppSettingsServiceOptions) {
    super();
    this.disabledAtStart = options.agents.disabledIds();
  }

  /** La consola que abre una nueva con lo que dice `settings.json`. */
  currentShell(): ShellLocation | null {
    return pickShell(this.options.shells, this.options.settings.get().console.shell);
  }

  status(): AppSettingsStatus {
    const settings = this.options.settings.get();
    return {
      consoleShell: settings.console.shell,
      consoleShells: this.options.shells.map(({ id, label }) => ({ id, label })),
      shellName: this.currentShell()?.name ?? null,
      disabledAgents: [...settings.agents.disabled],
      disabledAtStart: [...this.disabledAtStart],
    };
  }

  /** Guarda el cambio, avisa al registro si cambio la consola, y emite `status`. */
  async update(change: AppSettingsChange): Promise<void> {
    if (change.consoleShell !== undefined && !this.offered(change.consoleShell)) {
      throw new AppSettingsChangeError('shell-not-installed');
    }
    const before = this.currentShell();
    await this.options.settings.update({
      ...(change.consoleShell !== undefined ? { console: { shell: change.consoleShell } } : {}),
      ...(change.disabledAgents !== undefined ? { agents: { disabled: change.disabledAgents } } : {}),
    });
    const after = this.currentShell();
    if (after !== before) this.options.onShellChange(after);
    this.emit('status', this.status());
  }

  private offered(choice: ConsoleShellId): boolean {
    return choice === 'auto' || this.options.shells.some((shell) => shell.id === choice);
  }
}
