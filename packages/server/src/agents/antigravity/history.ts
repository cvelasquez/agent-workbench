/**
 * El historial de Antigravity CLI: una conversacion por carpeta de
 * `~/.gemini/antigravity-cli/brain/`, con titulo, carpeta y proyecto del
 * catalogo (`catalog.ts`).
 *
 * Solo lectura, y solo lo que nombra la lista de la especificacion del hito 27
 * (§2): de `brain/<id>/` unicamente `.system_generated/logs/transcript*.jsonl`
 * —ni `scratch/`, ni `.user_uploaded/`, ni `messages/`, ni `tasks/`, ni
 * `logs/chunks/`—; de `conversations/` solo `stat`; `~/.gemini` no se recorre
 * nunca y `~/.gemini/antigravity/` es del IDE.
 *
 * Tres raices para el watcher, y ninguna es la carpeta de la CLI entera:
 *
 *  1. `brain/`, con profundidad 3 y un filtro de **recorrido** (`ignore`) que no
 *     deja entrar mas que en el camino hasta los dos transcripts (M2).
 *  2. Los archivos del catalogo, por un sondeo de `stat` sobre esa lista exacta
 *     (`catalog-signal.ts`): la base la mantiene abierta la CLI.
 *  3. `~/.gemini/config/projects/`, sin profundidad, solo `*.json`.
 *
 * Que conversaciones se listan (lo que se encuentra, sin filtro de fecha: las
 * viejas se esconden con "Archivar historial…"):
 *
 *  - **No** los sub-agentes (`parent_conversation_id` o `nesting_depth`).
 *  - **No** las vacias: sin transcript, sin `.pb` con contenido, sin mensajes en
 *    `history.jsonl` y sin pasos en el indice. Es lo que deja un `/clear`.
 *  - **Si** las que no tienen transcript legible pero tienen historial en
 *    `.pb` (una version anterior): se listan, y el hilo dice por que no se ve.
 *
 * Y como se agrupan (A2): por `project_id`, salvo los proyectos genericos
 * (`default-cli-project`, `outside-of-project`), donde cada conversacion es su
 * propio grupo. Si no, el indice le prestaria a una conversacion sin carpeta la
 * de cualquier otra lanzada fuera de un proyecto.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionTitleSource } from '@agent-workbench/shared';
import { parseJsonlLine, readHeadLines } from '../../jsonl-reader.js';
import type {
  FollowOptions,
  HistoryItem,
  HistoryRoot,
  HistorySource,
  ScannedSession,
  SessionFollower,
} from '../adapter.js';
import { toTitle, UNTITLED_SESSION_TITLE } from '../session-title.js';
import { AntigravityCatalog, GENERIC_PROJECT_IDS } from './catalog.js';
import { FileStampSignal } from './catalog-signal.js';
import { CONVERSATION_ID_PATTERN } from './constants.js';
import { fileUriToPath } from './file-uri.js';
import {
  brainRoot,
  conversationFiles,
  historyPath,
  lastConversationsPath,
  projectFilePath,
  projectsRoot,
  summariesDbPath,
  transcriptPaths,
} from './paths.js';
import { AntigravitySessionFollower, type FollowerStatusLine } from './session-follower.js';
import { unwrapUserInput } from './transcript-mapper.js';

/**
 * Cada cuanto el hub relee una conversacion que alguien sigue. La CLI escribe el
 * transcript paso a paso, y en Windows un watcher no ve lo que se le agrega a un
 * archivo abierto (la leccion de Codex en el hito 25).
 */
export const ANTIGRAVITY_FOLLOW_POLL_MS = 1_000;

/** Cuanto de la cabeza del transcript se mira para el titulo. */
const TITLE_HEAD = { maxLines: 40, maxBytes: 512 * 1024 };

const TRANSCRIPT_NAMES: ReadonlySet<string> = new Set(['transcript_full.jsonl', 'transcript.jsonl']);
const SYSTEM_GENERATED = '.system_generated';
const LOGS = 'logs';

/**
 * Los tramos de `filePath` debajo de `root`, o null si no esta debajo. `[]` es
 * la raiz misma. Acepta `/` y `\` en los dos lados (chokidar arma las rutas con
 * `/` tambien en Windows) y, en Windows, sin mayusculas.
 */
export function segmentsUnder(root: string, filePath: string, platform: string = process.platform): string[] | null {
  const split = (value: string): string[] => value.split(/[\\/]+/).filter((part) => part.length > 0);
  const same = (a: string, b: string): boolean => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const base = split(root);
  const target = split(filePath);
  // Una ruta absoluta de POSIX empieza con `/`: los dos lados tienen que coincidir en eso tambien.
  if (/^[\\/]/.test(root) !== /^[\\/]/.test(filePath)) return null;
  if (target.length < base.length) return null;
  for (let index = 0; index < base.length; index += 1) {
    if (!same(base[index] ?? '', target[index] ?? '')) return null;
  }
  // Los tramos que siguen, con sus mayusculas: son nombres que se devuelven.
  return target.slice(base.length);
}

/**
 * El filtro de recorrido de `brain/` (M2): true para todo lo que no esta en el
 * camino `brain/<uuid>/.system_generated/logs/transcript(_full).jsonl`.
 * Decide por la forma de la ruta sola.
 */
export function ignoreInBrain(filePath: string, root: string = brainRoot(), platform: string = process.platform): boolean {
  const parts = segmentsUnder(root, filePath, platform);
  if (parts === null) return true;
  if (parts.length === 0) return false;
  const [id, generated, logs, name, ...rest] = parts;
  if (id === undefined || !CONVERSATION_ID_PATTERN.test(id)) return true;
  if (generated === undefined) return false;
  if (generated.toLowerCase() !== SYSTEM_GENERATED) return true;
  if (logs === undefined) return false;
  if (logs.toLowerCase() !== LOGS) return true;
  if (name === undefined) return false;
  return rest.length > 0 || !TRANSCRIPT_NAMES.has(name.toLowerCase());
}

/** El id de la conversacion de un transcript, o null si la ruta no es uno. */
export function transcriptConversationId(filePath: string, root: string = brainRoot(), platform: string = process.platform): string | null {
  const parts = segmentsUnder(root, filePath, platform);
  if (parts === null || parts.length !== 4 || ignoreInBrain(filePath, root, platform)) return null;
  return parts[0] ?? null;
}

/** Los archivos del catalogo que avisan cambios. */
export function catalogFiles(): string[] {
  const db = summariesDbPath();
  return [historyPath(), db, `${db}-wal`, lastConversationsPath()];
}

function isCatalogFile(filePath: string): boolean {
  const key = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  const target = key(filePath);
  return catalogFiles().some((file) => key(file) === target);
}

/** El id del proyecto de un `config/projects/<id>.json`, o null. */
function projectIdOf(filePath: string): string | null {
  const parts = segmentsUnder(projectsRoot(), filePath);
  if (parts === null || parts.length !== 1) return null;
  const name = path.basename(filePath);
  if (!name.toLowerCase().endsWith('.json')) return null;
  const id = name.slice(0, -'.json'.length);
  return projectFilePath(id) === null ? null : id;
}

interface Stamp {
  size: number;
  mtimeMs: number;
}

async function stamp(file: string): Promise<Stamp | null> {
  try {
    const info = await stat(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** El texto del primer mensaje del usuario en la cabeza de un transcript, o ''. */
async function firstUserText(file: string): Promise<string> {
  let found = '';
  try {
    await readHeadLines(file, {
      ...TITLE_HEAD,
      stopAfter: (line) => {
        const record = parseJsonlLine(line);
        if (record === null || record['type'] !== 'USER_INPUT' || record['source'] !== 'USER_EXPLICIT') return false;
        const content = record['content'];
        const text = typeof content === 'string' ? unwrapUserInput(content).text : '';
        if (text.length === 0) return false;
        found = text;
        return true;
      },
    });
  } catch {
    // Sin transcript, o tomado: el titulo sale de otra fuente.
  }
  return found;
}

export interface AntigravityHistoryDeps {
  catalog?: AntigravityCatalog;
  /** El aviso de cambios del catalogo. Por defecto, un sondeo de `stat` sobre `catalogFiles()`. */
  signal?: { subscribe(listener: (file: string) => void): () => void };
  /** Lo que el seguidor usa de la status line (paso 5 del hito). */
  statusLine?: FollowerStatusLine | null;
  platform?: string;
}

export function createAntigravityHistory(deps: AntigravityHistoryDeps = {}): HistorySource {
  const catalog = deps.catalog ?? new AntigravityCatalog();
  const signal = deps.signal ?? new FileStampSignal(catalogFiles);
  const platform = deps.platform ?? process.platform;

  /** El transcript que se sigue: el completo si existe, si no el compacto. */
  const transcriptOf = async (id: string): Promise<{ file: string; info: Stamp } | null> => {
    const paths = transcriptPaths(id);
    if (paths === null) return null;
    const full = await stamp(paths.full);
    if (full !== null) return { file: paths.full, info: full };
    const compact = await stamp(paths.compact);
    return compact === null ? null : { file: paths.compact, info: compact };
  };

  const itemOf = async (ref: string): Promise<HistoryItem | null> => {
    if (!CONVERSATION_ID_PATTERN.test(ref)) return null;
    if (!(await isDirectory(path.join(brainRoot(), ref)))) return null;
    const files = conversationFiles(ref);
    if (files === null) return null;
    const [transcript, pb, db] = await Promise.all([transcriptOf(ref), stamp(files.pb), stamp(files.db)]);
    const { history, summary } = catalog.get(ref);

    // Un sub-agente no se reanuda solo.
    if (summary !== null && (summary.parentConversationId.length > 0 || summary.nestingDepth > 0)) return null;
    const transcriptBytes = transcript?.info.size ?? 0;
    const empty =
      transcriptBytes === 0 && (pb?.size ?? 0) === 0 && history === null && (summary === null || summary.stepCount === 0);
    // Abierta y cerrada sin un mensaje (un `/clear`, una pestana que no llego a escribir).
    if (empty) return null;

    return {
      ref,
      sessionId: ref,
      group: summary !== null && !GENERIC_PROJECT_IDS.has(summary.projectId) ? summary.projectId : `conv:${ref.toLowerCase()}`,
      /*
        Tambien las fechas del catalogo de ESA conversacion: un titulo o una
        carpeta nuevos invalidan su entrada de la cache del indice sin tocar las
        demas.
      */
      mtimeMs: Math.max(
        transcript?.info.mtimeMs ?? 0,
        pb?.mtimeMs ?? 0,
        db?.mtimeMs ?? 0,
        history?.lastTimestamp ?? 0,
        summary?.lastModifiedMs ?? 0,
      ),
      sizeBytes: transcriptBytes,
    };
  };

  return {
    roots(): readonly HistoryRoot[] {
      const brain = brainRoot();
      const projects = projectsRoot();
      const cliFolder = path.dirname(historyPath());
      const settle = { stabilityThreshold: 300, pollInterval: 100 };
      return [
        {
          path: brain,
          depth: 3,
          accepts: (filePath) => transcriptConversationId(filePath, brain) !== null,
          ignore: (filePath) => ignoreInBrain(filePath, brain),
          awaitWriteFinish: settle,
        },
        {
          // Nunca se le pasa a chokidar: trae su propio aviso.
          path: cliFolder,
          depth: 0,
          accepts: isCatalogFile,
          awaitWriteFinish: false,
          watch: (onChange) => signal.subscribe(onChange),
        },
        {
          path: projects,
          depth: 0,
          accepts: (filePath) => projectIdOf(filePath) !== null,
          ignore: (filePath) => {
            const parts = segmentsUnder(projects, filePath);
            return parts === null || parts.length > 1 || (parts.length === 1 && !(parts[0] ?? '').toLowerCase().endsWith('.json'));
          },
          awaitWriteFinish: settle,
        },
      ];
    },

    async list(): Promise<HistoryItem[] | null> {
      if (!(await isDirectory(brainRoot()))) return null;
      await catalog.refresh();
      let names: string[];
      try {
        names = await readdir(brainRoot());
      } catch {
        return null;
      }
      const items: HistoryItem[] = [];
      for (const name of names) {
        const item = await itemOf(name);
        if (item !== null) items.push(item);
      }
      return items;
    },

    async changedRefs(filePath: string): Promise<readonly string[] | null> {
      const id = transcriptConversationId(filePath);
      if (id !== null) return [id];
      if (isCatalogFile(filePath)) {
        await catalog.refresh();
        return catalog.takeChanged();
      }
      const projectId = projectIdOf(filePath);
      if (projectId !== null) {
        // B4: la carpeta de esas conversaciones puede salir de este archivo.
        return catalog.idsWithProject(projectId);
      }
      return null;
    },

    item: (ref) => itemOf(ref),

    async scan(item: HistoryItem): Promise<ScannedSession | null> {
      const id = item.ref;
      const { history, lastWorkspace, summary } = catalog.get(id);

      const fromUri = summary?.workspaceUris[0];
      const cwd =
        (fromUri !== undefined ? fileUriToPath(fromUri, platform) : null) ??
        history?.workspace ??
        lastWorkspace ??
        (summary !== null ? await catalog.projectPath(summary.projectId) : null);

      let title = '';
      let titleSource: SessionTitleSource = 'none';
      const candidates: Array<[() => Promise<string> | string, SessionTitleSource]> = [
        // Puede ser un renombre del usuario desde `/resume`; no se distingue (B9).
        [() => summary?.title ?? '', 'ai'],
        [async () => {
          const transcript = await transcriptOf(id);
          return transcript === null || transcript.info.size === 0 ? '' : firstUserText(transcript.file);
        }, 'first-message'],
        [() => history?.firstDisplay ?? '', 'first-message'],
        [() => summary?.preview ?? '', 'first-message'],
      ];
      for (const [read, source] of candidates) {
        const text = toTitle(await read());
        if (text.length > 0) {
          title = text;
          titleSource = source;
          break;
        }
      }
      if (title.length === 0) {
        title = UNTITLED_SESSION_TITLE;
        titleSource = 'none';
      }

      return {
        cwd: cwd ?? null,
        summary: {
          sessionId: item.sessionId,
          title,
          titleSource,
          updatedAt: item.mtimeMs,
          sizeBytes: item.sizeBytes,
        },
        extra: {},
      };
    },

    // No se aprende nada de la instalacion al leer una conversacion.
    restored: () => undefined,

    /**
     * true si hay algo que reanudar (M3): transcript con contenido, `.pb` con
     * contenido o pasos en el indice. La 1.2.2 crea el `.db` y la carpeta tambien
     * con un `/clear`, y `--conversation` sobre eso reanuda una conversacion
     * vacia. El `cwd` no importa: la ruta sale del id.
     */
    async exists(_cwd: string, sessionId: string): Promise<boolean> {
      if (!CONVERSATION_ID_PATTERN.test(sessionId)) return false;
      if (((await transcriptOf(sessionId))?.info.size ?? 0) > 0) return true;
      const files = conversationFiles(sessionId);
      if (files !== null && ((await stamp(files.pb))?.size ?? 0) > 0) return true;
      await catalog.refresh();
      return (catalog.get(sessionId).summary?.stepCount ?? 0) > 0;
    },

    /**
     * true si `brain/` es una carpeta. Separa las dos razones por las que `list`
     * da null: sin carpeta (no hay historial) o con la carpeta ilegible (lo hay,
     * pero ahora no se lee).
     */
    rootExists: () => isDirectory(brainRoot()),

    follow(target: { cwd: string; sessionId: string }, options?: FollowOptions): SessionFollower {
      return new AntigravitySessionFollower(target.sessionId, {
        statusLine: deps.statusLine ?? null,
        platform,
        limits: options?.limits,
        maxEvents: options?.maxEvents,
      });
    },

    // `follow` respeta `FollowOptions`: la copia propia puede leer de aca (hito 28).
    wholeRead: true,

    plans: null,

    followPollMs: ANTIGRAVITY_FOLLOW_POLL_MS,
  };
}
