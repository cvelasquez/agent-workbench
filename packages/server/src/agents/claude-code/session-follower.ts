/**
 * El seguidor de una sesion de Claude Code, tal como lo usa el hub.
 *
 * No reescribe `ConversationFollower`: lo contiene y le suma lo que el hub
 * hacia por fuera, que es de esta CLI y no de todas.
 *
 *  - **La configuracion se aplica antes de la primera lectura.** El archivo
 *    nunca dice la variante del modelo (§4.5.1) y `settings.json` si: sin esto
 *    el medidor muestra 200k un instante y 1M despues.
 *  - **Un `/model` relee la configuracion antes de devolver.** Si no, el hub
 *    emitiria primero el numero viejo y el medidor tardaria un turno en
 *    corregirse.
 *  - **El re-apuntado de respaldo.** Si la ruta calculada no aparece nunca y el
 *    watcher ve nacer un `<sessionId>.jsonl` en otra carpeta, el seguimiento se
 *    muda ahi. Es barato y cubre que la CLI normalice el `cwd` de una forma que
 *    no previmos.
 *  - **El archivo donde este** (Hito 54, §4.11.2). Al arrancar, si la ruta
 *    calculada no existe y el id tiene archivo en otra carpeta, se sigue ese: el
 *    de una conversacion que se paso a una rama aparte queda en la carpeta de la
 *    principal. Y la pestana que se muda sigue el mismo archivo sin reabrirlo
 *    (`retarget`): reabrir uno que la CLI acaba de escribir espera al antivirus.
 */

import path from 'node:path';
import {
  normalizeCwdKey,
  type ContextUsage,
  type ConversationImageSource,
  type ConversationState,
  type ConversationSubagent,
  type PermissionMode,
  type QueuedPrompt,
} from '@agent-workbench/shared';
import type { EventPage, FollowOptions, LoadedImage, PollResult, SessionFollower } from '../adapter.js';
import { readAgentDefaults } from './agent-defaults.js';
import { ConversationFollower } from './conversation-follower.js';
import { loadConversationImage } from './conversation-image.js';
import type { ModelVariantRegistry } from './model-variants.js';
import { findSessionFile, sessionFilePath } from './paths.js';

/**
 * true si dos rutas nombran el mismo archivo, sin tocar el disco.
 *
 * La ruta propia sale de `sessionFilePath(cwd)`, con las mayusculas del `cwd`
 * de la pestana; la del watcher trae las de la carpeta **en disco**. En Windows
 * `D:\Agent X` y `d:\agent x` dan dos slugs que NTFS resuelve a la misma
 * carpeta, y comparar con `===` dejaba la conversacion congelada: el aviso no
 * era "suyo" y el re-apuntado no entra en una sesion que ya se esta leyendo.
 *
 * Es la misma regla de forma que agrupa proyectos (`normalizeCwdKey`): en
 * Windows sin mayusculas; en los demas, las mayusculas cuentan.
 */
export function isSameFilePath(a: string, b: string, platform: string): boolean {
  return a === b || normalizeCwdKey(a, platform) === normalizeCwdKey(b, platform);
}

export class ClaudeCodeSessionFollower implements SessionFollower {
  private inner: ConversationFollower;

  /** `options`: ver `FollowOptions`. Vale tambien para el seguidor del re-apuntado. */
  constructor(
    private cwd: string,
    private readonly sessionId: string,
    private readonly variants: ModelVariantRegistry,
    private readonly options: FollowOptions = {},
  ) {
    this.inner = new ConversationFollower(sessionFilePath(cwd, sessionId), variants, {
      ...options,
      // Las raices de los documentos que la conversacion nombre (hito 31).
      target: { cwd, sessionId },
    });
  }

  get label(): string {
    return this.inner.filePath;
  }

  async start(): Promise<void> {
    await this.locate();
    await this.applyDefaults();
  }

  /**
   * Antes de la primera lectura: si el archivo no esta donde se calcula y el id
   * tiene uno en otra carpeta, se sigue ese (Hito 54). Sin ninguno, la ruta
   * calculada, que es donde va a escribir una sesion nueva.
   */
  private async locate(): Promise<void> {
    const found = await findSessionFile(this.cwd, this.sessionId);
    if (found === null || isSameFilePath(found, this.inner.filePath, process.platform)) return;
    void this.inner.close();
    this.inner = new ConversationFollower(found, this.variants, {
      ...this.options,
      target: { cwd: this.cwd, sessionId: this.sessionId },
    });
  }

  /**
   * La pestana se mudo a `cwd` con la misma conversacion (Hito 54, §6.38).
   * true si el archivo sigue siendo el que se lee: se sigue leyendo por el que
   * ya estaba abierto, y desde ahora los documentos y la configuracion son los
   * de la carpeta nueva. false si es otro: quien llama arma un seguidor nuevo.
   */
  async retarget(cwd: string): Promise<boolean> {
    const found = await findSessionFile(cwd, this.sessionId);
    if (found === null || !isSameFilePath(found, this.inner.filePath, process.platform)) return false;
    this.cwd = cwd;
    this.inner.setTarget({ cwd, sessionId: this.sessionId });
    await this.applyDefaults();
    this.inner.recomputeModel();
    return true;
  }

  async poll(): Promise<PollResult> {
    // Si lanza, lanza: el hub lo loguea con `label`.
    const result = await this.inner.poll();
    // Un `/model` en el archivo significa que la configuracion pudo cambiar.
    // Se relee y se rehace la cuenta antes de devolver, para que quien emite
    // no mande primero el numero viejo.
    if (this.inner.takeConfiguredStale()) {
      await this.applyDefaults();
      this.inner.recomputeModel();
    }
    return result;
  }

  /**
   * Relee el modelo que declara la configuracion de la pestana.
   *
   * Son tres archivos chicos y solo se leen al abrir la conversacion o cuando
   * paso un `/model`, no en cada poll: la configuracion cambia cuando el
   * usuario la cambia, no cada 300 ms.
   */
  private async applyDefaults(): Promise<void> {
    if (this.cwd.length === 0) return;
    try {
      const defaults = await readAgentDefaults(this.cwd);
      this.inner.setConfiguredAlias(defaults.model);
    } catch {
      // Sin configuracion legible se sigue igual: es un dato de conveniencia.
    }
  }

  noticeChange(filePath: string): boolean {
    if (isSameFilePath(this.inner.filePath, filePath, process.platform)) return true;

    if (
      this.inner.getState() === 'waiting' &&
      path.basename(filePath).toLowerCase() === `${this.sessionId.toLowerCase()}.jsonl`
    ) {
      console.warn(
        `[conversation] session ${this.sessionId.slice(0, 8)} wrote to ${filePath}, not to the computed path; moving there.`,
      );
      // El de la ruta vieja ya no se lee: si quedo algo abierto, se suelta.
      void this.inner.close();
      // Sin registro de variantes, igual que antes de mudarse aca (D11); con los topes que se pidieron.
      this.inner = new ConversationFollower(filePath, undefined, {
        ...this.options,
        target: { cwd: this.cwd, sessionId: this.sessionId },
      });
      return true;
    }
    return false;
  }

  readImage(
    eventId: string,
    index: number,
    source: ConversationImageSource,
  ): Promise<LoadedImage | null> {
    return loadConversationImage(this.inner.filePath, eventId, index, source);
  }

  getState(): ConversationState {
    return this.inner.getState();
  }

  getUsage(): ContextUsage {
    return this.inner.getUsage();
  }

  getPermissionMode(): PermissionMode | null {
    return this.inner.getPermissionMode();
  }

  getTail(limit: number): EventPage {
    return this.inner.getTail(limit);
  }

  getPageBefore(beforeEventId: string, limit: number): EventPage {
    return this.inner.getPageBefore(beforeEventId, limit);
  }

  getPlanFiles(): readonly string[] {
    return this.inner.getPlanFiles();
  }

  /**
   * Siempre false: esta CLI publica su estado, y un permiso pendiente lo dice
   * `~/.claude/sessions/` (§4.13) sin adivinarlo por el historial.
   */
  hasOpenToolCall(): boolean {
    return false;
  }

  /** Los subagentes del proceso de `launchedAt` que siguen trabajando (§4.15). */
  runningSubagents(launchedAt: number): readonly ConversationSubagent[] {
    return this.inner.runningSubagents(launchedAt);
  }

  /** Los mensajes del proceso de `launchedAt` que esperan en la cola de la CLI (hito 45, §4.4.3). */
  queuedPrompts(launchedAt: number): readonly QueuedPrompt[] {
    return this.inner.queuedPrompts(launchedAt);
  }

  /** Esconde desde un mensaje que la CLI deshizo sin escribirlo todavia (hito 44, §4.16). */
  withdrawFrom(eventId: string): boolean {
    return this.inner.withdrawFrom(eventId);
  }

  withdrawnFrom(): string | null {
    return this.inner.withdrawnFrom();
  }

  /** Suelta el archivo que se dejo abierto con `keepOpen` (§4.11.1). */
  close(): Promise<void> {
    return this.inner.close();
  }
}
