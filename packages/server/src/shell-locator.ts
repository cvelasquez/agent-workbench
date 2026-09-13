/**
 * Localiza la consola del sistema para el panel derecho.
 *
 * Esto **no** es la CLI y no comparte ni una regla con ella. La CLI se busca
 * una sola vez, se lanza sin tocar y su ausencia bloquea la app entera; la
 * consola es una comodidad: si no aparece ninguna, el panel lo dice y el resto
 * sigue funcionando igual.
 *
 * En Windows el orden es deliberado:
 *
 *  1. `pwsh` — PowerShell 7, si el usuario lo instalo. Es el que usa quien lo
 *     tiene, y esta en el PATH.
 *  2. `powershell` — Windows PowerShell 5.1. Se busca **por ruta absoluta**
 *     ademas de por PATH: un PATH recortado no es motivo para quedarse sin
 *     consola en una maquina que la trae de fabrica.
 *  3. `ComSpec` — cmd.exe. Ultimo recurso; existe siempre.
 *
 * En macOS y Linux se usa `$SHELL`, que es lo que el usuario ya eligio, y
 * `/bin/bash` como respaldo.
 *
 * No se le agrega ni se le quita nada al entorno aca: eso lo decide
 * `AgentRegistry.consoleEnvironment()` en `agents/registry.ts`, con los mismos
 * filtros que usan las pestanas de cada CLI.
 */

import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { findInPath } from './agents/locate.js';

export interface ShellLocation {
  /** Ejecutable a lanzar. */
  file: string;
  /** Argumentos fijos. Vacio salvo para silenciar el banner de PowerShell. */
  args: readonly string[];
  /** Nombre corto para la UI: "PowerShell", "cmd", "bash". */
  name: string;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `powershell.exe` de la instalacion del sistema.
 *
 * Se arma desde `SystemRoot` y no desde una ruta escrita a mano: Windows puede
 * estar en otra unidad, y en esa maquina `C:\\Windows\\...` no existe.
 */
function windowsPowerShellPath(): string | null {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'];
  if (systemRoot === undefined || systemRoot.length === 0) return null;
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function locateWindowsShell(): Promise<ShellLocation | null> {
  const pwsh = await findInPath('pwsh');
  // -NoLogo saca el cartel de arranque. Es la unica bandera que se pasa: la
  // consola tiene que comportarse como la que el usuario abre por su cuenta.
  if (pwsh !== null) return { file: pwsh, args: ['-NoLogo'], name: 'PowerShell' };

  const fromPath = await findInPath('powershell');
  if (fromPath !== null) return { file: fromPath, args: ['-NoLogo'], name: 'PowerShell' };

  const systemCopy = windowsPowerShellPath();
  if (systemCopy !== null && (await isExecutable(systemCopy))) {
    return { file: systemCopy, args: ['-NoLogo'], name: 'PowerShell' };
  }

  const comSpec = process.env['ComSpec'];
  if (comSpec !== undefined && comSpec.length > 0 && (await isExecutable(comSpec))) {
    return { file: comSpec, args: [], name: 'cmd' };
  }
  return null;
}

async function locatePosixShell(): Promise<ShellLocation | null> {
  const preferred = process.env['SHELL'];
  if (preferred !== undefined && preferred.length > 0 && (await isExecutable(preferred))) {
    return { file: preferred, args: [], name: path.basename(preferred) };
  }
  if (await isExecutable('/bin/bash')) return { file: '/bin/bash', args: [], name: 'bash' };
  if (await isExecutable('/bin/sh')) return { file: '/bin/sh', args: [], name: 'sh' };
  return null;
}

/** Devuelve null si no se encontro ninguna consola utilizable. */
export async function locateShell(): Promise<ShellLocation | null> {
  return process.platform === 'win32' ? locateWindowsShell() : locatePosixShell();
}
