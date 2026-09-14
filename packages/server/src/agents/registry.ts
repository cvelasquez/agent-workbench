/**
 * Las CLIs registradas y donde esta cada una.
 *
 * Es el unico lugar del servidor que conoce la lista de adaptadores. El resto
 * pide uno por id, o recorre todos, y no nombra ninguna CLI.
 *
 * Los adaptadores se importan de forma **estatica**: el paquete de npm sale de
 * un bundle que sigue los imports, y un `import()` con ruta calculada dejaria el
 * paquete sin ninguno.
 */

import {
  normalizeCwdKey,
  type AgentId,
  type AgentInfo,
  type TerminalKind,
} from '@agent-workbench/shared';
import type { AgentAdapter, CliLocation } from './adapter.js';
import { createClaudeCodeAdapter } from './claude-code/index.js';
import { createCodexAdapter } from './codex/index.js';
import { createOpenCodeAdapter } from './opencode/index.js';

export interface RegisteredAgent {
  adapter: AgentAdapter;
  location: CliLocation | null;
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, RegisteredAgent>();

  /** El orden del array es el orden de preferencia para `defaultAgent`. */
  constructor(adapters: readonly AgentAdapter[]) {
    for (const adapter of adapters) {
      if (this.agents.has(adapter.id)) {
        throw new Error(`Adaptador registrado dos veces: ${adapter.id}`);
      }
      this.agents.set(adapter.id, { adapter, location: null });
    }
  }

  /**
   * Localiza todos a la vez. Se llama una vez al arrancar.
   *
   * En paralelo porque cada uno puede correr `--version`, y eso son segundos
   * que el arranque no tiene por que sumar.
   */
  async locateAll(): Promise<void> {
    await Promise.all(
      [...this.agents.values()].map(async (entry) => {
        entry.location = await entry.adapter.locate();
      }),
    );
  }

  get(id: AgentId): RegisteredAgent | null {
    return this.agents.get(id) ?? null;
  }

  /** El adaptador aunque su CLI no este instalada: el historial se lee igual. */
  adapter(id: AgentId): AgentAdapter {
    const entry = this.agents.get(id);
    if (entry === undefined) throw new Error(`No hay adaptador para ${id}`);
    return entry.adapter;
  }

  all(): readonly RegisteredAgent[] {
    return [...this.agents.values()];
  }

  /** Lo que viaja al cliente en `hello`. */
  list(): AgentInfo[] {
    return this.all().map(({ adapter, location }) => ({
      id: adapter.id,
      label: adapter.label,
      command: adapter.command,
      available: location !== null,
      version: location?.version ?? null,
      installUrl: adapter.installUrl,
      missingMessage: location === null ? adapter.missingMessage() : null,
      capabilities: adapter.capabilities,
      environmentNotice: adapter.environment(process.env).notice,
    }));
  }

  /** La primera disponible, en orden de registro, o null. */
  defaultAgent(): AgentId | null {
    return this.all().find((entry) => entry.location !== null)?.adapter.id ?? null;
  }

  anyAvailable(): boolean {
    return this.defaultAgent() !== null;
  }

  /**
   * El entorno de todo lo que la app lanza: el de cada adaptador, encadenado.
   *
   * Lo usan las consolas del pie **y** las pestanas de cualquier CLI (hito 25,
   * C22). Desde una consola se puede lanzar cualquier CLI a mano, y una CLI
   * puede lanzar a otra como herramienta: en los dos casos tiene que arrancar
   * igual que desde su propia pestana, sin el marcador que le apaga el
   * transcript a una ni lo que le estorbe a otra. Con una sola CLI registrada es
   * exactamente el entorno de su adaptador. Como cada adaptador solo quita,
   * encadenarlos nunca agrega nada.
   */
  composedEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
    let env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) env[key] = value;
    }
    for (const { adapter } of this.agents.values()) {
      env = adapter.environment(env).env;
    }
    return env;
  }

  /** Union de las carpetas protegidas de todos, instalados o no. */
  protectedDirs(): readonly string[] {
    const dirs = new Set<string>();
    for (const { adapter } of this.agents.values()) {
      for (const dir of adapter.protectedDirs()) dirs.add(dir);
    }
    return [...dirs];
  }

  disposeAll(): void {
    for (const { adapter } of this.agents.values()) adapter.dispose();
  }
}

export interface ResolveAgentInput {
  /** La CLI que pidio el cliente, si pidio una. */
  requested: AgentId | undefined;
  cwd: string;
  /** Si viene, la pestana reanuda esa sesion del historial. */
  resumeSessionId: string | undefined;
  /**
   * De que CLI es `resumeSessionId`, segun el indice del historial, o null si
   * no lo sabe. Sin reanudacion no se mira.
   */
  sessionAgent: AgentId | null;
  tabs: readonly { kind: TerminalKind; agent: AgentId | null; cwd: string }[];
  defaultAgent: AgentId | null;
  /** `process.platform` del servidor: decide como se comparan los `cwd`. */
  platform: string;
}

/**
 * Que CLI usa una pestana nueva. Puro, sin disco: lo prueba el chequeo.
 *
 *  1. La que se pidio, siempre.
 *  2. **Reanudando**, la de esa sesion y nunca la de otra pestana: una sesion es
 *     de la CLI que la escribio, y lanzar otra con su id no la encuentra. Si el
 *     indice todavia no la conoce, la CLI por defecto — con una sola CLI es la
 *     misma de siempre.
 *  3. Si no, la de la **ultima** pestana de agente del mismo proyecto: quien
 *     abre otra pestana en un proyecto casi siempre quiere seguir con la CLI
 *     que ya estaba usando ahi. Las consolas no cuentan.
 *  4. Si no, la CLI por defecto. null si no hay ninguna.
 */
export function resolveAgentForOpen(input: ResolveAgentInput): AgentId | null {
  if (input.requested !== undefined) return input.requested;

  if (input.resumeSessionId !== undefined) return input.sessionAgent ?? input.defaultAgent;

  const key = normalizeCwdKey(input.cwd, input.platform);
  let fromTabs: AgentId | null = null;
  for (const tab of input.tabs) {
    if (tab.kind !== 'agent' || tab.agent === null) continue;
    if (normalizeCwdKey(tab.cwd, input.platform) === key) fromTabs = tab.agent;
  }
  return fromTabs ?? input.defaultAgent;
}

/**
 * El registro de la app, con todos los adaptadores que hay.
 *
 * Claude Code primero: con las dos instaladas sigue siendo la CLI por defecto,
 * y `Alt+T` en un proyecto sin pestanas abre lo mismo que abria antes de que
 * existiera la segunda. OpenCode ultima (hito 26): el orden tambien decide que
 * `cwd` muestra un proyecto que comparten, y con las tres instaladas nada de lo
 * que ya habia cambia de lugar.
 */
export function createAgentRegistry(): AgentRegistry {
  return new AgentRegistry([createClaudeCodeAdapter(), createCodexAdapter(), createOpenCodeAdapter()]);
}
