import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CliLocation } from '../locate.js';

const execFileAsync = promisify(execFile);
const START_TIMEOUT_MS = 90_000;
const VERSION_TIMEOUT_MS = 10_000;

export type CodexDaemonCommandRunner = (
  location: CliLocation,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<string>;

export type CodexDaemonPrewarmer = (location: CliLocation, env: NodeJS.ProcessEnv) => Promise<void>;

async function runCodexCommand(
  location: CliLocation,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      location.file,
      [...location.prefixArgs, ...args],
      { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    return stdout;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    throw new Error(`codex-daemon-command-failed:${code}`);
  }
}

/** El comando de administracion del daemon se verifico desde Codex CLI 0.166.0. */
export function supportsCodexDaemonStart(version: string | null): boolean {
  const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
  if (match === null || match === undefined) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [0, 166, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index]! > minimum[index]!;
  }
  return true;
}

function lastJsonObject(output: string): Record<string, unknown> | null {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || !line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // El comando puede imprimir diagnosticos antes de su respuesta JSON.
    }
  }
  return null;
}

function profileKey(env: NodeJS.ProcessEnv): string {
  const configured = Object.entries(env).find(([key]) => key.toLowerCase() === 'codex_home')?.[1];
  return configured?.trim() ? path.resolve(configured).toLowerCase() : '<default-codex-home>';
}

async function startAndVerify(
  location: CliLocation,
  env: NodeJS.ProcessEnv,
  run: CodexDaemonCommandRunner,
): Promise<void> {
  try {
    const current = await run(location, ['app-server', 'daemon', 'version'], env, VERSION_TIMEOUT_MS);
    const status = lastJsonObject(current);
    if (status?.['status'] === 'running' && typeof status['appServerVersion'] === 'string') return;
  } catch {
    // Sin socket activo, `version` falla. `start` instala o levanta el daemon.
  }
  await run(location, ['app-server', 'daemon', 'start'], env, START_TIMEOUT_MS);
  const output = await run(location, ['app-server', 'daemon', 'version'], env, VERSION_TIMEOUT_MS);
  const status = lastJsonObject(output);
  if (status?.['status'] !== 'running' || typeof status['appServerVersion'] !== 'string') {
    throw new Error('codex-daemon-not-ready');
  }
}

/** Prepara el daemon antes de abrir la TUI para que el primer adjunto no llegue como ruta. */
export function createCodexDaemonPrewarmer(
  run: CodexDaemonCommandRunner = runCodexCommand,
): CodexDaemonPrewarmer {
  const inFlight = new Map<string, Promise<void>>();

  return (location, env) => {
    if (!supportsCodexDaemonStart(location.version)) return Promise.resolve();
    const key = profileKey(env);
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const pending = startAndVerify(location, env, run).finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  };
}

export const prewarmCodexDaemon = createCodexDaemonPrewarmer();
