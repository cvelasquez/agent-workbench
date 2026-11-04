import { spawn } from 'node:child_process';
import { access, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CODEX_QUEUE_MAX_TEXT_LENGTH } from '@agent-workbench/shared';
import type { CliLocation } from '../locate.js';
import { findInPath } from '../locate.js';
import { isUuid } from './paths.js';

const QUEUE_TIMEOUT_MS = 30_000;

export type CodexQueueResult = 'queued' | 'failed' | 'unavailable' | 'not-busy';

export interface CodexQueueLauncher {
  file: string;
  prefixArgs: readonly string[];
}

/** Codex 0.166 exposes the stable text-only `codex queue` command. */
export function supportsCodexQueue(version: string | null): boolean {
  const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
  if (match === null || match === undefined) return false;
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const minimum = [0, 166, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index]! > minimum[index]!;
  }
  return true;
}

function argsForCodexQueue(sessionId: string, text: string): string[] {
  return ['queue', '--thread', sessionId, '--message', text];
}

async function regularFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile() && (await access(candidate).then(() => true, () => false));
  } catch {
    return false;
  }
}

/**
 * Un `.cmd` de npm tiene que pasar por cmd.exe, que interpreta `%`, `&` y
 * cambia caracteres segun la pagina de codigos. Se detecta el shim de npm de
 * Codex y se ejecuta su entrypoint JavaScript directamente con Node y argv
 * nativo. Otros shims no se declaran compatibles.
 */
export async function codexQueueLauncher(location: CliLocation): Promise<CodexQueueLauncher | null> {
  const extension = path.extname(location.resolvedPath).toLowerCase();
  if (process.platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return { file: location.file, prefixArgs: location.prefixArgs };
  }

  let shim: string;
  try {
    shim = await readFile(location.resolvedPath, 'utf8');
  } catch {
    return null;
  }
  const entry = shim.match(/"%_prog%"\s+"%dp0%\\([^"\r\n]+\.js)"/i)?.[1];
  if (entry === undefined) return null;
  const base = path.dirname(location.resolvedPath);
  const script = path.resolve(base, entry.replace(/[\\/]/g, path.sep));
  const relative = path.relative(base, script);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await regularFile(script))) {
    return null;
  }

  const adjacentNode = path.join(base, 'node.exe');
  const node = (await regularFile(adjacentNode)) ? adjacentNode : await findInPath('node');
  return node === null ? null : { file: node, prefixArgs: [script] };
}

/**
 * Pone texto en la cola nativa de Codex. El texto se pasa como un argumento
 * separado al proceso, sin interpretación de shell.
 */
export async function queueCodexText(
  launcher: CodexQueueLauncher,
  target: { cwd: string; sessionId: string },
  text: string,
): Promise<void> {
  if (
    !isUuid(target.sessionId) ||
    text.trim().length === 0 ||
    text.length > CODEX_QUEUE_MAX_TEXT_LENGTH
  ) {
    throw new Error('invalid-queue-request');
  }

  const args = argsForCodexQueue(target.sessionId, text);

  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launcher.file, [...launcher.prefixArgs, ...args], {
        cwd: target.cwd,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      reject(new Error('codex-queue-failed'));
      return;
    }

    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('codex-queue-timeout'));
    }, QUEUE_TIMEOUT_MS);
    timer.unref();

    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(new Error(`codex-queue-spawn:${error.code ?? 'unknown'}`));
    });
    child.once('exit', (code, signal) => {
      finish(code === 0 ? undefined : new Error(`codex-queue-exit:${code ?? 'null'}:${signal ?? 'none'}`));
    });

  });
}
