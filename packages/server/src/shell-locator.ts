/**
 * Localiza las consolas del sistema para el pie de la columna derecha.
 *
 * Esto **no** es la CLI y no comparte ni una regla con ella. La CLI se busca
 * una sola vez, se lanza sin tocar y su ausencia bloquea la app entera; la
 * consola es una comodidad: si no aparece ninguna, el panel lo dice y el resto
 * sigue funcionando igual.
 *
 * Desde el Hito 41 se buscan **todas** las que hay, y el usuario elige cual abre
 * una consola nueva (Ajustes, `settings.json`). "Automatico" es el orden de
 * siempre, que en Windows es deliberado:
 *
 *  1. `pwsh` — PowerShell 7, si el usuario lo instalo. Es el que usa quien lo
 *     tiene, y esta en el PATH.
 *  2. `powershell` — Windows PowerShell 5.1. Se busca **por ruta absoluta**
 *     ademas de por PATH: un PATH recortado no es motivo para quedarse sin
 *     consola en una maquina que la trae de fabrica.
 *  3. `ComSpec` — cmd.exe. Ultimo recurso; existe siempre.
 *
 * Git Bash nunca es la automatica: se ofrece para elegirla. Se busca al lado de
 * `git` —`bin\bash.exe` subiendo desde donde esta `git.exe`, que puede ser
 * `cmd\` o `ucrt64\bin\`— y en las dos carpetas de instalacion de siempre, sin
 * recorrer el disco. El `bash.exe` de `System32` es WSL, no Git Bash, y no se
 * mira.
 *
 * En macOS y Linux la automatica es `$SHELL`, que es lo que el usuario ya
 * eligio, y se ofrecen ademas `bash` y `zsh` si estan.
 *
 * No se le agrega ni se le quita nada al entorno aca: eso lo decide
 * `AgentRegistry.composedEnvironment()` en `agents/registry.ts`, el mismo que
 * usan las pestanas de cada CLI.
 */

import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ConsoleShellId } from '@agent-workbench/shared';
import { findInPath } from './agents/locate.js';

export interface ShellLocation {
  /** Ejecutable a lanzar. */
  file: string;
  /** Argumentos fijos. Vacio salvo para silenciar el banner de PowerShell o abrir bash interactivo. */
  args: readonly string[];
  /** Nombre corto para la UI: "PowerShell", "cmd", "Git Bash", "bash". */
  name: string;
}

/** Una consola instalada, con el id con que se la elige. */
export interface ShellCandidate {
  id: Exclude<ConsoleShellId, 'auto'>;
  /** Como se la nombra en Ajustes, donde PowerShell 7 y Windows PowerShell tienen que distinguirse. */
  label: string;
  location: ShellLocation;
}

/** Lo que el localizador mira del sistema. Inyectable para el chequeo. */
export interface ShellProbe {
  platform: string;
  env: NodeJS.ProcessEnv;
  findInPath: (command: string) => Promise<string | null>;
  isExecutable: (candidate: string) => Promise<boolean>;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const SYSTEM_PROBE: ShellProbe = {
  platform: process.platform,
  env: process.env,
  findInPath,
  isExecutable,
};

/**
 * `powershell.exe` de la instalacion del sistema.
 *
 * Se arma desde `SystemRoot` y no desde una ruta escrita a mano: Windows puede
 * estar en otra unidad, y en esa maquina `C:\\Windows\\...` no existe.
 */
function windowsPowerShellPath(env: NodeJS.ProcessEnv): string | null {
  const systemRoot = env['SystemRoot'] ?? env['windir'];
  if (systemRoot === undefined || systemRoot.length === 0) return null;
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Donde puede estar el `bash.exe` de Git: subiendo desde `git.exe`, y en las carpetas de siempre. */
export function gitBashCandidates(gitPath: string | null, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (gitPath !== null) {
    let dir = path.win32.dirname(gitPath);
    for (let level = 0; level < 3; level++) {
      candidates.push(path.win32.join(dir, 'bin', 'bash.exe'));
      const parent = path.win32.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const base of [env['ProgramFiles'], env['LOCALAPPDATA'] === undefined ? undefined : path.win32.join(env['LOCALAPPDATA'], 'Programs')]) {
    if (base !== undefined && base.length > 0) candidates.push(path.win32.join(base, 'Git', 'bin', 'bash.exe'));
  }
  // El de System32 es el lanzador de WSL, no Git Bash.
  const systemRoot = (env['SystemRoot'] ?? env['windir'] ?? '').toLowerCase();
  return [...new Set(candidates)].filter((candidate) => systemRoot.length === 0 || !candidate.toLowerCase().startsWith(systemRoot));
}

async function locateWindowsShells(probe: ShellProbe): Promise<ShellCandidate[]> {
  const found: ShellCandidate[] = [];
  // -NoLogo saca el cartel de arranque. Es la unica bandera que se pasa: la
  // consola tiene que comportarse como la que el usuario abre por su cuenta.
  const pwsh = await probe.findInPath('pwsh');
  if (pwsh !== null) found.push({ id: 'pwsh', label: 'PowerShell 7', location: { file: pwsh, args: ['-NoLogo'], name: 'PowerShell' } });

  const fromPath = await probe.findInPath('powershell');
  const systemCopy = windowsPowerShellPath(probe.env);
  const windowsPowerShell =
    fromPath ?? (systemCopy !== null && (await probe.isExecutable(systemCopy)) ? systemCopy : null);
  if (windowsPowerShell !== null) {
    // En sus solapas sigue siendo "PowerShell", como antes del Hito 41.
    found.push({ id: 'powershell', label: 'Windows PowerShell', location: { file: windowsPowerShell, args: ['-NoLogo'], name: 'PowerShell' } });
  }

  const comSpec = probe.env['ComSpec'];
  if (comSpec !== undefined && comSpec.length > 0 && (await probe.isExecutable(comSpec))) {
    found.push({ id: 'cmd', label: 'cmd', location: { file: comSpec, args: [], name: 'cmd' } });
  }

  for (const candidate of gitBashCandidates(await probe.findInPath('git'), probe.env)) {
    if (await probe.isExecutable(candidate)) {
      // Interactiva y de inicio de sesion, como la abre el acceso directo de Git Bash.
      found.push({ id: 'git-bash', label: 'Git Bash', location: { file: candidate, args: ['--login', '-i'], name: 'Git Bash' } });
      break;
    }
  }
  return found;
}

async function locatePosixShells(probe: ShellProbe): Promise<ShellCandidate[]> {
  const found: ShellCandidate[] = [];
  const preferred = probe.env['SHELL'];
  if (preferred !== undefined && preferred.length > 0 && (await probe.isExecutable(preferred))) {
    const name = path.posix.basename(preferred);
    found.push({ id: 'login', label: name, location: { file: preferred, args: [], name } });
  }
  // En el orden de siempre para la automatica ($SHELL, bash, sh); zsh solo se elige.
  for (const [id, file] of [['bash', '/bin/bash'], ['sh', '/bin/sh'], ['zsh', '/bin/zsh']] as const) {
    if (found.some((shell) => shell.location.file === file)) continue;
    if (await probe.isExecutable(file)) found.push({ id, label: id, location: { file, args: [], name: id } });
  }
  return found;
}

/**
 * Las consolas instaladas, en el orden de la automatica. Git Bash y zsh nunca
 * son la automatica: sin las de siempre, la automatica es ninguna antes que una
 * que el usuario no eligio.
 */
export async function locateShells(probe: ShellProbe = SYSTEM_PROBE): Promise<ShellCandidate[]> {
  return probe.platform === 'win32' ? locateWindowsShells(probe) : locatePosixShells(probe);
}

/** Se ofrecen para elegir pero nunca son la automatica, que es la de antes del Hito 41. */
const NEVER_AUTO: ReadonlySet<ConsoleShellId> = new Set<ConsoleShellId>(['git-bash', 'zsh']);

/**
 * La consola que abre una nueva: la elegida si esta instalada; si no —o con
 * "Automatico"—, la primera de las de siempre. null si no hay ninguna.
 */
export function pickShell(candidates: readonly ShellCandidate[], choice: ConsoleShellId): ShellLocation | null {
  if (choice !== 'auto') {
    const chosen = candidates.find((candidate) => candidate.id === choice);
    if (chosen !== undefined) return chosen.location;
  }
  return candidates.find((candidate) => !NEVER_AUTO.has(candidate.id))?.location ?? null;
}
