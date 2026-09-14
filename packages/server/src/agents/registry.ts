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
import { createAntigravityAdapter } from './antigravity/index.js';
import { createClaudeCodeAdapter } from './claude-code/index.js';
import { createCodexAdapter } from './codex/index.js';
import { createOpenCodeAdapter } from './opencode/index.js';

export interface RegisteredAgent {
  adapter: AgentAdapter;
  location: CliLocation | null;
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, RegisteredAgent>();
  /** Las suscripciones a cambios de configuracion que siguen abiertas, para soltarlas al apagar. */
  private readonly changeSubscriptions = new Set<() => void>();

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

  /**
   * Lo que cada CLI encontrada prepara en las carpetas de la app
   * (`AgentAdapter.prepare`). Se llama una vez al arrancar, despues de
   * `locateAll()` y **despues** de mover la carpeta de configuracion del nombre
   * viejo: si un adaptador creara algo en la nueva antes, la migracion se
   * saltaria y el usuario perderia de vista notas, archivadas y pestanas (A1).
   *
   * Solo las encontradas: quien no usa una CLI no tiene por que ver archivos
   * nuevos por ella. Un adaptador que falla no frena a los demas.
   */
  async prepareAll(): Promise<void> {
    await Promise.all(
      [...this.agents.values()]
        .filter((entry) => entry.location !== null && entry.adapter.prepare !== undefined)
        .map(async ({ adapter }) => {
          try {
            await adapter.prepare?.();
          } catch (error) {
            console.warn(`[agentes] ${adapter.label} no pudo preparar lo suyo: ${String(error)}`);
          }
        }),
    );
  }

  /**
   * Relee lo que cada CLI encontrada anuncia de su configuracion (el boton
   * "Comprobar" del dialogo de la status line). true si algo cambio.
   */
  async refreshSetups(): Promise<boolean> {
    const results = await Promise.all(
      [...this.agents.values()]
        .filter((entry) => entry.location !== null && entry.adapter.refreshSetup !== undefined)
        .map(async ({ adapter }) => {
          try {
            return (await adapter.refreshSetup?.()) === true;
          } catch {
            return false;
          }
        }),
    );
    return results.some(Boolean);
  }

  /**
   * Avisa cuando cambia lo que anuncia alguna CLI encontrada, sin que nadie lo
   * pida: el usuario configuro su status line. Quien escucha reenvia la lista
   * de CLIs (`agents`). Devuelve la desuscripcion; `disposeAll` suelta las que
   * queden.
   */
  subscribeChanges(listener: () => void): () => void {
    const stops = [...this.agents.values()]
      .filter((entry) => entry.location !== null && entry.adapter.subscribeChanges !== undefined)
      .map(({ adapter }) => adapter.subscribeChanges?.(listener) ?? (() => undefined));
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      this.changeSubscriptions.delete(stop);
      for (const each of stops) each();
    };
    this.changeSubscriptions.add(stop);
    return stop;
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
      // Solo la CLI con status line opcional la declara (hito 27); las demas, null.
      // Y solo encontrada: sin ella `prepareAll` no instalo el script ni se vigila
      // su configuracion, y el dialogo ofreceria una linea que apunta a la nada.
      statusLine: location === null ? null : (adapter.statusLine?.() ?? null),
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
    for (const stop of [...this.changeSubscriptions]) stop();
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
 * que ya habia cambia de lugar. Antigravity CLI detras de todas (hito 27), por
 * lo mismo.
 */
export function createAgentRegistry(): AgentRegistry {
  return new AgentRegistry([
    createClaudeCodeAdapter(),
    createCodexAdapter(),
    createOpenCodeAdapter(),
    createAntigravityAdapter(),
  ]);
}
