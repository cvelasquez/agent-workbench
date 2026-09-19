/**
 * `pnpm vault:import`: los importadores de un solo uso, desde la terminal
 * (hito 28, §9.1).
 *
 *   pnpm vault:import gemini-cli      [--cwd <ruta>]... [--write]
 *   pnpm vault:import antigravity-ide --workspace <ruta> [--write]
 *
 * **En seco por defecto.** Sin `--write` imprime lo que haria —cuantas
 * sesiones, cuanto pesan, que se salta y por que— y no crea nada: ni la carpeta
 * de la copia ni `vault.json`. Con `--write` escribe en la carpeta de
 * `settings.json` (o la de por defecto) por el mismo `writeSessionFile` que la
 * pasada, asi que lo importado es una sesion de la copia como cualquier otra.
 * Reimportar pisa lo importado antes con el mismo par: correrlo dos veces deja
 * lo mismo.
 *
 * Vive aca y no en el script para que el chequeo lo pruebe sin lanzar un
 * proceso. No necesita el servidor andando, y el servidor no lo importa: no
 * entra al paquete de npm (lo comprueba el caso 15).
 */

import path from 'node:path';
import { appSettingsPath } from '../../paths.js';
import type { SqliteLoad } from '../../agents/sqlite.js';
import { isAbsoluteDir, SettingsStore } from '../../settings-store.js';
import { VaultCatalog } from '../catalog.js';
import { defaultVaultDir } from '../paths.js';
import type { SerializedSession } from '../serialize.js';
import { writeSessionFile } from '../write.js';
import { planAntigravityRescue, RescueError, rescuedSessionFiles } from './antigravity-ide.js';
import { GEMINI_SKIP_TEXT, GEMINI_UNKNOWN_GROUP, geminiSessionFiles, planGeminiCliImport, type GeminiSkipReason } from './gemini-cli.js';

export const VAULT_IMPORT_USAGE = [
  'Usage:',
  '  pnpm vault:import gemini-cli      [--cwd <path>]... [--write]',
  '  pnpm vault:import antigravity-ide --workspace <path> [--write]',
  '',
  'Without --write nothing is written: it says what it would import.',
  '  gemini-cli       the chats in ~/.gemini/tmp/*/chats. --cwd names a folder where Gemini CLI',
  '                   was used, to place its chats in that project (can be repeated).',
  '  antigravity-ide  what is readable from the IDE conversations of that folder: the summary of',
  "                   each one and its .md documents. The conversation content can't be read.",
].join('\n');

export type VaultImporterName = 'gemini-cli' | 'antigravity-ide';

/**
 * Una ruta de Windows con las barras invertidas repetidas colapsadas, salvo las
 * dos del principio de una UNC.
 *
 * No es cosmetico. pnpm 11 **duplica** cada `\` de un argumento al pasarlo a un
 * script, y otra vez por cada nivel de `pnpm --filter`: medido desde PowerShell
 * y desde Git Bash, `pnpm vault:import gemini-cli --cwd 'x\y'` le llega al
 * script como `x\\\\y`. Con eso el hash de `--cwd` no casaria nunca. Una ruta
 * de Windows no tiene barras repetidas que signifiquen algo, asi que colapsarlas
 * devuelve lo que escribio el usuario.
 */
export function collapseBackslashes(value: string): string {
  const unc = /^\\{2,}/.test(value);
  const rest = value.replace(/^\\+/, (lead) => (unc ? '' : lead)).replace(/\\{2,}/g, '\\');
  return unc ? `\\\\${rest}` : rest;
}

export type ParsedImportArgs =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; importer: VaultImporterName; cwds: string[]; workspace: string | null; write: boolean };

/** Los argumentos, validados. Pura. */
export function parseImportArgs(argv: readonly string[], platform: string): ParsedImportArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (args.length === 0) return { kind: 'error', message: 'The importer is missing.' };
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };

  const [importer, ...rest] = args;
  if (importer !== 'gemini-cli' && importer !== 'antigravity-ide') {
    return { kind: 'error', message: `Unknown importer: ${JSON.stringify(importer)}.` };
  }

  const cwds: string[] = [];
  let workspace: string | null = null;
  let write = false;
  for (let position = 0; position < rest.length; position += 1) {
    const token = rest[position] ?? '';
    if (token === '--write') {
      write = true;
      continue;
    }
    const match = /^(--cwd|--workspace)(?:=(.*))?$/s.exec(token);
    if (match === null) return { kind: 'error', message: `Unknown argument: ${JSON.stringify(token)}.` };
    const flag = match[1];
    let value = match[2];
    if (value === undefined) {
      value = rest[position + 1];
      position += 1;
    }
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      return { kind: 'error', message: `${flag} needs a path.` };
    }
    if (platform === 'win32') value = collapseBackslashes(value);
    if (!isAbsoluteDir(value, platform)) {
      return { kind: 'error', message: `${flag} has to be an absolute path: ${JSON.stringify(value)}.` };
    }
    if (flag === '--cwd') {
      if (importer !== 'gemini-cli') return { kind: 'error', message: '--cwd is only for gemini-cli.' };
      cwds.push(value);
    } else {
      if (importer !== 'antigravity-ide') return { kind: 'error', message: '--workspace is only for antigravity-ide.' };
      if (workspace !== null) return { kind: 'error', message: '--workspace can only be given once.' };
      workspace = value;
    }
  }
  if (importer === 'antigravity-ide' && workspace === null) {
    return { kind: 'error', message: 'antigravity-ide needs --workspace <path>: the project folder.' };
  }
  return { kind: 'run', importer, cwds, workspace, write };
}

export interface VaultImportContext {
  out: (line: string) => void;
  err: (line: string) => void;
  /** La carpeta del usuario: de ahi sale `~/.gemini`. */
  homeDir: string;
  platform: string;
  now: () => number;
  /** Ausente: el `settings.json` de la app. */
  settingsPath?: string;
  /** Donde va la copia efimera de la base del rescate. */
  tempRoot?: string;
  sqlite?: () => SqliteLoad;
}

/** El dia local como AAAA-MM-DD: la salida es en ingles, y ahi 11-02 se lee como noviembre (hito 34, D19). */
function formatDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const bytesOf = (sessions: readonly SerializedSession[]): number =>
  sessions.reduce((sum, session) => sum + Buffer.byteLength(session.text, 'utf8'), 0);

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Escribe las sesiones y dice cuantas. Una sesion cuya copia es de un formato mas nuevo no se pisa (D15). */
async function writeAll(dir: string, sessions: readonly SerializedSession[], context: VaultImportContext): Promise<void> {
  if (sessions.length === 0) {
    context.out('There is nothing to write.');
    return;
  }
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  let written = 0;
  let foreign = 0;
  for (const session of sessions) {
    if (catalog.hasForeignFormat(session.header.agent, session.header.sessionId)) {
      foreign += 1;
      continue;
    }
    await writeSessionFile(dir, session);
    written += 1;
  }
  context.out(`Wrote ${plural(written, 'session', 'sessions')} to ${path.join(dir, 'sessions', sessions[0]?.header.agent ?? '')}.`);
  if (foreign > 0) {
    context.out(`Didn't overwrite ${plural(foreign, 'session', 'sessions')}: ${foreign === 1 ? 'its copy is' : 'their copies are'} in a newer format than this version.`);
  }
  context.out('If the app is open, ⟳ Reindex shows them.');
}

/** Corre un importador. Devuelve el codigo de salida: 0 bien, 1 fallo, 2 uso incorrecto. */
export async function runVaultImport(argv: readonly string[], context: VaultImportContext): Promise<number> {
  const parsed = parseImportArgs(argv, context.platform);
  if (parsed.kind === 'help') {
    context.out(VAULT_IMPORT_USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    context.err(parsed.message);
    context.err(VAULT_IMPORT_USAGE);
    return 2;
  }

  const settings = new SettingsStore(context.settingsPath ?? appSettingsPath(), {
    platform: context.platform,
    log: { warn: (message) => context.err(message) },
  });
  await settings.load();
  const dir = settings.get().vault.dir ?? defaultVaultDir();
  const geminiHome = path.join(context.homeDir, '.gemini');
  const now = context.now();

  try {
    let sessions: SerializedSession[];
    if (parsed.importer === 'gemini-cli') {
      const plan = await planGeminiCliImport({
        geminiHome,
        cwdCandidates: parsed.cwds,
        toolResultMaxChars: settings.get().vault.toolResultMaxChars,
      });
      sessions = geminiSessionFiles(plan, now);
      const unknown = plan.chats.length - plan.matchedCwd;
      context.out(`Gemini CLI, chats in ${path.join(geminiHome, 'tmp')}`);
      context.out(`  Found: ${plan.found}`);
      context.out(`  To import: ${plan.chats.length} (${bytesOf(sessions)} bytes)`);
      context.out(`    with a matched folder: ${plan.matchedCwd}`);
      context.out(`    without a folder: ${unknown}${unknown > 0 ? ` (they go to "${GEMINI_UNKNOWN_GROUP}")` : ''}`);
      const skipped = Object.entries(plan.skipped) as [GeminiSkipReason, number][];
      context.out(`  Skipped: ${skipped.reduce((sum, [, count]) => sum + count, 0)}`);
      for (const [reason, count] of skipped) context.out(`    ${count}: ${GEMINI_SKIP_TEXT[reason]}`);
    } else {
      const workspace = parsed.workspace ?? '';
      const plan = await planAntigravityRescue({
        workspace,
        geminiHome,
        platform: context.platform,
        now: context.now,
        ...(context.tempRoot === undefined ? {} : { tempRoot: context.tempRoot }),
        ...(context.sqlite === undefined ? {} : { sqlite: context.sqlite }),
      });
      sessions = rescuedSessionFiles(plan, now);
      context.out(`Antigravity IDE, conversations of ${workspace}`);
      const range = plan.range === null ? 'no dates' : `from ${formatDay(plan.range.from)} to ${formatDay(plan.range.to)}`;
      context.out(`  Conversations: ${plan.conversations.length}, with ${plan.steps} steps, ${range}`);
      context.out(`  Documents: ${plan.documents} (${plan.documentBytes} bytes) in ${plural(plan.conversationsWithDocuments, 'conversation', 'conversations')}`);
      context.out(`  IDE rows from other folders: ${plan.otherRows} (not touched)`);
      if (plan.invalidIds > 0) context.out(`  Skipped for an id that can't be saved: ${plan.invalidIds}`);
      context.out(`  To write: ${plural(sessions.length, 'partial session', 'partial sessions')} (${bytesOf(sessions)} bytes)`);
    }

    if (!parsed.write) {
      context.out(`Dry run: nothing was written. With --write they're written to ${dir}.`);
      return 0;
    }
    await writeAll(dir, sessions, context);
    return 0;
  } catch (error) {
    context.err(error instanceof RescueError ? error.message : `The import failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
