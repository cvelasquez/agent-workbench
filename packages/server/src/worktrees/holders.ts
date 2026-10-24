/**
 * Quién tiene abierta la carpeta de una rama aparte, para nombrarlo en el
 * diálogo de quitarla (23-10-2026, §6.38). Pedido del usuario: el diálogo decía
 * que otro programa tenía la carpeta y que volviera a intentar, sin decir cuál.
 *
 * Sólo en Windows, que es donde una carpeta abierta no se deja quitar
 * (`folderInUse`). Node no llega a esa API sin un módulo nativo, así que lo
 * pregunta el PowerShell que trae Windows, con un poco de C# que compila
 * `Add-Type`:
 *
 *  1. recorre la carpeta sin seguir enlaces, primero las carpetas, por
 *     niveles, y después los archivos, con tope de entradas y de tiempo;
 *  2. de cada una mira si alguien más la tiene abierta: la abre sin compartir,
 *     sin leerla, y la suelta enseguida (unos 40 µs, medido). La carpeta de
 *     arriba, en cambio, con permiso de borrar y compartiéndolo todo: un vigía
 *     de `fs.watch` ahí no impide renombrarla (medido), y no se nombra;
 *  3. sólo de esas pide los procesos (`FileProcessIdsUsingFileInformation`, lo
 *     que usa el Administrador de reinicio de Windows): unos 33 ms cada una,
 *     medido, y por eso el filtro;
 *  4. de cada proceso, sólo el ejecutable (`QueryFullProcessImageName`, con el
 *     permiso mínimo de consulta) y la descripción que trae el ejecutable.
 *
 * Lo que no alcanza a mirar no se nombra, y si algo falla o no encuentra a
 * nadie, el diálogo dice lo de antes. Este servidor no se nombra nunca: cerrar
 * la app no es la salida que se le sugiere al usuario.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { WORKTREE_HOLDERS_MAX, asRecord, parseJson, parseWorktreeHolder, type WorktreeHolder } from '@agent-workbench/shared';
import { debugLog } from '../debug.js';

/** Hasta dónde recorre. Con un `node_modules` puede no llegar a los archivos del final: no se nombran. */
const SCAN_MAX_ENTRIES = 200_000;
const SCAN_MAX_MS = 4_000;
/** PowerShell entero: arrancar, compilar (unos 250 ms, medido) y recorrer. */
const HOLDERS_TIMEOUT_MS = 15_000;
/** Su salida es una línea de JSON con unos pocos procesos. */
const OUTPUT_MAX_CHARS = 256 * 1024;

// Sólo ASCII, también en los comentarios: PowerShell lee la entrada con la página de códigos de la consola.
const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class AwFolderHolders {
  [StructLayout(LayoutKind.Sequential)]
  struct IoStatus { public IntPtr Status; public IntPtr Information; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FindData {
    public uint Attributes;
    public uint Created1, Created2, Accessed1, Accessed2, Written1, Written2;
    public uint SizeHigh, SizeLow, Reserved0, Reserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
  }

  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationFile(SafeFileHandle file, out IoStatus status, IntPtr buffer, int length, int infoClass);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr FindFirstFileExW(string name, int level, out FindData data, int search, IntPtr filter, int flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool FindNextFileW(IntPtr find, out FindData data);
  [DllImport("kernel32.dll")]
  static extern bool FindClose(IntPtr find);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  const uint ReadData = 0x1, ReadAttributes = 0x80, Delete = 0x10000, ShareAll = 7, OpenExisting = 3;
  /* BACKUP_SEMANTICS abre carpetas; OPEN_REPARSE_POINT abre el enlace y no su destino. */
  const uint OpenFlags = 0x02000000 | 0x00200000;
  const int ProcessIdsUsingFile = 47, QueryLimited = 0x1000, MaxNamed = 32;
  static readonly IntPtr NoFind = new IntPtr(-1);

  static bool Taken(string path, bool top) {
    using (SafeFileHandle file = CreateFileW(path, top ? Delete : ReadData, top ? ShareAll : 0, IntPtr.Zero, OpenExisting, OpenFlags, IntPtr.Zero)) {
      if (!file.IsInvalid) return false;
      int error = Marshal.GetLastWin32Error();
      return error != 2 && error != 3;
    }
  }

  static void Collect(string path, HashSet<int> seen, List<int> found, int self) {
    using (SafeFileHandle file = CreateFileW(path, ReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, OpenFlags, IntPtr.Zero)) {
      if (file.IsInvalid) return;
      for (int size = 4096; size <= 1 << 20; size *= 4) {
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          IoStatus status;
          int code = NtQueryInformationFile(file, out status, buffer, size, ProcessIdsUsingFile);
          if (code == unchecked((int)0xC0000004) || code == unchecked((int)0x80000005)) continue;
          if (code != 0) return;
          int count = Marshal.ReadInt32(buffer);
          if (IntPtr.Size * (count + 1) > size) continue;
          for (int i = 0; i < count; i++) {
            int pid = (int)Marshal.ReadIntPtr(buffer, IntPtr.Size * (i + 1)).ToInt64();
            if (pid != self && seen.Add(pid)) found.Add(pid);
          }
          return;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
    }
  }

  static string Json(string value) {
    if (value == null) return "null";
    StringBuilder text = new StringBuilder("\"");
    foreach (char c in value) {
      if (c == '"' || c == '\\') text.Append('\\').Append(c);
      else if (c < 0x20 || c > 0x7E) text.Append("\\u").Append(((int)c).ToString("x4"));
      else text.Append(c);
    }
    return text.Append('"').ToString();
  }

  public static string Scan(string root, int maxEntries, int maxMs) {
    Stopwatch clock = Stopwatch.StartNew();
    int self = Process.GetCurrentProcess().Id;
    HashSet<int> seen = new HashSet<int>();
    List<int> found = new List<int>();
    List<string> files = new List<string>();
    Queue<string> dirs = new Queue<string>();
    bool complete = true;
    int entries = 0;
    if (Taken(root, true)) Collect(root, seen, found, self);
    dirs.Enqueue(root);
    while (dirs.Count > 0) {
      if (++entries > maxEntries || clock.ElapsedMilliseconds > maxMs) { complete = false; break; }
      string dir = dirs.Dequeue();
      if (dir != root && Taken(dir, false)) Collect(dir, seen, found, self);
      FindData data;
      IntPtr find = FindFirstFileExW(dir + "\\*", 1, out data, 0, IntPtr.Zero, 2);
      if (find == NoFind) continue;
      try {
        do {
          if (data.Name == "." || data.Name == "..") continue;
          string child = dir + "\\" + data.Name;
          if ((data.Attributes & 0x10) != 0 && (data.Attributes & 0x400) == 0) dirs.Enqueue(child);
          else if (files.Count < maxEntries) files.Add(child);
        } while (FindNextFileW(find, out data));
      } finally { FindClose(find); }
    }
    if (complete) {
      foreach (string file in files) {
        if (++entries > maxEntries || clock.ElapsedMilliseconds > maxMs) { complete = false; break; }
        if (Taken(file, false)) Collect(file, seen, found, self);
      }
    }
    StringBuilder json = new StringBuilder("{\"complete\":");
    json.Append(complete ? "true" : "false").Append(",\"ms\":").Append(clock.ElapsedMilliseconds).Append(",\"holders\":[");
    int named = 0;
    foreach (int pid in found) {
      if (named >= MaxNamed) break;
      string name = null, description = null;
      IntPtr process = OpenProcess(QueryLimited, false, pid);
      if (process != IntPtr.Zero) {
        try {
          StringBuilder image = new StringBuilder(32768);
          int length = image.Capacity;
          if (QueryFullProcessImageNameW(process, 0, image, ref length)) {
            string full = image.ToString(0, length);
            name = Path.GetFileName(full);
            try { description = FileVersionInfo.GetVersionInfo(full).FileDescription; } catch { }
          }
        } finally { CloseHandle(process); }
      }
      if (name == null) {
        try { name = pid == 4 ? "System" : Process.GetProcessById(pid).ProcessName + ".exe"; } catch { continue; }
      }
      json.Append(named++ == 0 ? "" : ",").Append("{\"pid\":").Append(pid).Append(",\"name\":").Append(Json(name))
        .Append(",\"description\":").Append(Json(description)).Append('}');
    }
    return json.Append("]}").ToString();
  }
}
`;

/** La ruta con el prefijo de Windows para rutas largas: en un `node_modules` de pnpm pasan de 260. */
function longPath(folder: string): string {
  const absolute = path.win32.resolve(folder);
  if (absolute.startsWith('\\\\?\\')) return absolute;
  return absolute.startsWith('\\\\') ? `\\\\?\\UNC\\${absolute.slice(2)}` : `\\\\?\\${absolute}`;
}

/**
 * El guion que corre PowerShell. La ruta va en base64: así ningún carácter de
 * su nombre (una comilla, también las tipográficas, que PowerShell toma como
 * comillas) se lee como parte del guion.
 */
export function holdersScript(folder: string): string {
  const encoded = Buffer.from(longPath(folder), 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$source = @'\n${CSHARP}\n'@`,
    'Add-Type -TypeDefinition $source',
    `$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    `[Console]::Out.WriteLine([AwFolderHolders]::Scan($root, ${SCAN_MAX_ENTRIES}, ${SCAN_MAX_MS}))`,
    // Con `-Command -`, la última línea corre recién con la línea en blanco de después.
    '',
    '',
  ].join('\n');
}

export interface HoldersScan {
  holders: WorktreeHolder[];
  /** false si el tope cortó el recorrido. */
  complete: boolean;
  /** true si `selfPid` estaba entre ellos: se saca de la lista. */
  self: boolean;
}

/**
 * Los programas de la salida del guion, sin `selfPid` (este servidor) y sin
 * repetidos; null si no se entiende. Lo que no tiene la forma se descarta.
 */
export function parseHoldersOutput(output: string, selfPid: number): HoldersScan | null {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith('{"complete":'));
  const record = line === undefined ? null : asRecord(parseJson(line));
  if (record === null || typeof record['complete'] !== 'boolean' || !Array.isArray(record['holders'])) return null;
  const holders: WorktreeHolder[] = [];
  let self = false;
  for (const item of record['holders']) {
    const holder = parseWorktreeHolder(item);
    if (holder === null || holders.some((other) => other.pid === holder.pid)) continue;
    if (holder.pid === selfPid) self = true;
    else if (holders.length < WORKTREE_HOLDERS_MAX) holders.push(holder);
  }
  return { holders, complete: record['complete'], self };
}

function powershellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** La salida de PowerShell con el guion por la entrada, o null si no arrancó, se pasó de tiempo o habló de más. */
function runPowerShell(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, HOLDERS_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length <= OUTPUT_MAX_CHARS) return;
      child.kill();
      finish(null);
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(output));
    // Si PowerShell no arrancó, escribirle falla: lo dice `error`.
    child.stdin.on('error', () => undefined);
    child.stdin.end(script);
  });
}

/**
 * Los programas que tienen abierta `folder`, sin este servidor. Vacío fuera
 * de Windows, si no encuentra a nadie o si algo falla: el diálogo dice
 * entonces lo de antes.
 */
export async function folderHolders(folder: string): Promise<WorktreeHolder[]> {
  if (process.platform !== 'win32') return [];
  const output = await runPowerShell(holdersScript(folder));
  const parsed = output === null ? null : parseHoldersOutput(output, process.pid);
  if (parsed === null) {
    console.warn(`[worktrees] couldn't tell which programs have ${folder} open`);
    return [];
  }
  // Si es este servidor, la app soltó mal algo suyo: que quede en la consola.
  if (parsed.self) console.warn(`[worktrees] this server has ${folder} open`);
  debugLog('worktrees', `holders of ${folder}: ${parsed.holders.length}, complete ${parsed.complete}`);
  return parsed.holders;
}
