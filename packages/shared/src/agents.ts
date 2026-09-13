/**
 * Las CLIs que la app sabe manejar y lo que cada una permite.
 *
 * La interfaz no pregunta "¿es tal CLI?": pregunta "¿esta CLI tiene ciclo de
 * modos?", "¿acepta imagenes por ruta?". Cada respuesta es una capacidad
 * declarada por el adaptador del servidor y medida contra la CLI de verdad
 * (docs/plan-multi-cli.md §5), y viaja al cliente en `hello`.
 *
 * Todo lo que llega por la red pasa por los parsers de abajo, con la misma
 * regla que el resto de `shared/`: un campo que este lado no entiende no rompe
 * nada, cae al valor que no promete nada.
 */

import type { ModelOption } from './agent-controls.js';
import { isPermissionMode, type PermissionMode } from './permission-modes.js';
import {
  asArrayOf,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
} from './validation.js';

/**
 * Ids de las CLIs que tienen adaptador en el servidor.
 *
 * Son el nombre de cada CLI como **dato** de compatibilidad, en un solo lugar
 * (regla 2.3): ninguna funcion ni pantalla del producto lleva ese nombre. Cada
 * hito que agrega un adaptador agrega su id aca.
 *
 * No es la misma lista que `MEMORY_AGENT_IDS` (`memory.ts`), y no por descuido:
 * la memoria compartida nombra CLIs que todavia no tienen adaptador —les
 * escribe el archivo de instrucciones, no las lanza—. Lo que si tiene que
 * valer siempre es que esta lista este contenida en aquella: una CLI que la
 * app lanza tiene que poder usar la memoria. Lo comprueba
 * `check-agent-registry.mjs`.
 */
export const AGENT_IDS = ['claude-code'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Como nombra la CLI una imagen adjunta por ruta. `at-quoted`: `@"ruta"`. */
export type ImageReferenceStyle = 'at-quoted';
export const IMAGE_REFERENCE_STYLES: readonly ImageReferenceStyle[] = ['at-quoted'];

/** Como se menciona un archivo tecleandolo en la terminal. `at`: `@ruta `. */
export type FileMentionStyle = 'at';
export const FILE_MENTION_STYLES: readonly FileMentionStyle[] = ['at'];

/**
 * De donde sale la ventana de contexto.
 *
 * `usage-with-variants`: tokens por respuesta mas la variante resuelta
 * (CLAUDE.md 4.5.1).
 */
export type ContextWindowSource = 'usage-with-variants';
export const CONTEXT_WINDOW_SOURCES: readonly ContextWindowSource[] = ['usage-with-variants'];

/** Avisos de entorno que un adaptador puede levantar al arrancar. */
export type EnvironmentNoticeId = 'child-session-marker';
export const ENVIRONMENT_NOTICE_IDS: readonly EnvironmentNoticeId[] = ['child-session-marker'];

export interface PermissionCycleCapability {
  /** El ciclo, en el orden en que lo recorre la tecla. */
  modes: readonly PermissionMode[];
  /** Con que modo lanza la app cada pestana. Punto de partida de la cuenta. */
  launchMode: PermissionMode;
  /** Nombre de la tecla que cicla, para los textos ("shift+tab"). */
  keyLabel: string;
}

/** Un nivel de esfuerzo ofrecido: lo que se le pasa al comando y como se lee. */
export interface EffortOption {
  value: string;
  label: string;
}

/**
 * Lo que la interfaz dibuja o esconde, por CLI.
 *
 * Cada campo es una decision medida, no una promesa. Viaja al cliente en
 * `hello`.
 */
export interface AgentCapabilities {
  /** La app fija el id de sesion al lanzar. false = hay que descubrirlo. */
  sessionIdAtLaunch: boolean;
  /** Se puede reanudar una sesion por id. */
  resume: boolean;
  /** La CLI publica ocupada/libre/esperando por proceso. */
  statusSource: boolean;
  /** Se puede esperar "lista para recibir" antes de pegar (mandar una nota). */
  readySignal: boolean;
  permissionCycle: PermissionCycleCapability | null;
  /**
   * Modelos que acepta el comando de modelo con argumento, o null si la CLI no
   * lo tiene.
   *
   * Es la lista y no un "si/no" porque otra CLI acepta el mismo comando con
   * otros nombres: con un booleano, el combo quedaria atado a los de esta.
   */
  models: readonly ModelOption[] | null;
  /** Niveles que acepta el comando de esfuerzo con argumento, o null. */
  efforts: readonly EffortOption[] | null;
  /** Las preguntas de eleccion se contestan desde la tarjeta. */
  questionCards: boolean;
  imagesByPath: ImageReferenceStyle | null;
  /** "Insertar como @ruta" del arbol de archivos. */
  fileMentions: FileMentionStyle | null;
  /** "Volver aqui" manda Esc Esc. */
  rewind: boolean;
  contextWindowSource: ContextWindowSource | null;
  /** Solapa Planes. */
  plans: boolean;
}

/** Nada declarado. Es el valor de cada campo ausente o invalido al parsear. */
export const NO_CAPABILITIES: AgentCapabilities = {
  sessionIdAtLaunch: false,
  resume: false,
  statusSource: false,
  readySignal: false,
  permissionCycle: null,
  models: null,
  efforts: null,
  questionCards: false,
  imagesByPath: null,
  fileMentions: null,
  rewind: false,
  contextWindowSource: null,
  plans: false,
};

/** Una CLI tal como la ve el cliente. */
export interface AgentInfo {
  id: AgentId;
  /** Lo que ve el usuario cuando hay mas de una CLI para elegir. */
  label: string;
  /** Nombre en el PATH. */
  command: string;
  available: boolean;
  /** Primera linea de `--version`, o null. */
  version: string | null;
  installUrl: string;
  /** Texto listo para mostrar cuando `available` es false; null si esta. */
  missingMessage: string | null;
  capabilities: AgentCapabilities;
  environmentNotice: EnvironmentNoticeId | null;
}

/** true si hay que ofrecer elegir CLI: mas de una disponible. */
export function shouldOfferAgentChoice(agents: readonly AgentInfo[]): boolean {
  return agents.filter((agent) => agent.available).length > 1;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * El ciclo de modos, o null.
 *
 * Todo o nada: un ciclo con un modo que este cliente no conoce no se puede
 * recorrer contando pulsaciones, y un punto de partida que no esta en el ciclo
 * tampoco.
 */
export function parsePermissionCycle(value: unknown): PermissionCycleCapability | null {
  const record = asRecord(value);
  if (record === null) return null;

  const rawModes = record['modes'];
  if (!Array.isArray(rawModes) || rawModes.length === 0) return null;
  const modes: PermissionMode[] = [];
  for (const mode of rawModes) {
    if (!isPermissionMode(mode)) return null;
    modes.push(mode);
  }

  const launchMode = record['launchMode'];
  if (!isPermissionMode(launchMode) || !modes.includes(launchMode)) return null;

  const keyLabel = asNonEmptyString(record['keyLabel']);
  if (keyLabel === null) return null;

  return { modes, launchMode, keyLabel };
}

function parseModelOption(value: unknown): ModelOption | null {
  const record = asRecord(value);
  if (record === null) return null;

  const optionValue = asNonEmptyString(record['value']);
  const label = asString(record['label']);
  const family = asString(record['family']);
  const long = asBoolean(record['long']);
  const rawWindow = record['window'];
  const window = rawWindow === null ? null : asFiniteNumber(rawWindow);
  if (
    optionValue === null ||
    label === null ||
    family === null ||
    long === null ||
    (rawWindow !== null && window === null)
  ) {
    return null;
  }
  return { value: optionValue, label, family, long, window };
}

function parseEffortOption(value: unknown): EffortOption | null {
  const record = asRecord(value);
  if (record === null) return null;
  const optionValue = asNonEmptyString(record['value']);
  const label = asString(record['label']);
  if (optionValue === null || label === null) return null;
  return { value: optionValue, label };
}

/**
 * Una lista de opciones de comando, o null.
 *
 * Una lista vacia es null: un combo sin opciones no tiene nada que ofrecer, y
 * decir que el comando existe sin ningun valor que mandarle seria prometer un
 * control que no hace nada.
 */
function parseOptions<T>(value: unknown, parseItem: (item: unknown) => T | null): T[] | null {
  const options = asArrayOf(value, parseItem);
  return options === null || options.length === 0 ? null : options;
}

/**
 * Nunca devuelve null. Cada campo se lee por separado y lo que falta o no se
 * entiende cae al valor de `NO_CAPABILITIES`: un campo nuevo de un servidor mas
 * nuevo esconde un control, no rompe la pantalla.
 */
export function parseAgentCapabilities(value: unknown): AgentCapabilities {
  const record = asRecord(value);
  if (record === null) return { ...NO_CAPABILITIES };

  return {
    sessionIdAtLaunch: record['sessionIdAtLaunch'] === true,
    resume: record['resume'] === true,
    statusSource: record['statusSource'] === true,
    readySignal: record['readySignal'] === true,
    permissionCycle: parsePermissionCycle(record['permissionCycle']),
    models: parseOptions(record['models'], parseModelOption),
    efforts: parseOptions(record['efforts'], parseEffortOption),
    questionCards: record['questionCards'] === true,
    imagesByPath: asLiteral(record['imagesByPath'], IMAGE_REFERENCE_STYLES),
    fileMentions: asLiteral(record['fileMentions'], FILE_MENTION_STYLES),
    rewind: record['rewind'] === true,
    contextWindowSource: asLiteral(record['contextWindowSource'], CONTEXT_WINDOW_SOURCES),
    plans: record['plans'] === true,
  };
}

/** Una CLI, o null si su id no es uno que este cliente conozca. */
export function parseAgentInfo(value: unknown): AgentInfo | null {
  const record = asRecord(value);
  if (record === null) return null;

  const id = asLiteral(record['id'], AGENT_IDS);
  const label = asString(record['label']);
  const command = asString(record['command']);
  const installUrl = asString(record['installUrl']);
  if (id === null || label === null || command === null || installUrl === null) return null;

  return {
    id,
    label,
    command,
    available: record['available'] === true,
    version: asString(record['version']),
    installUrl,
    missingMessage: asString(record['missingMessage']),
    capabilities: parseAgentCapabilities(record['capabilities']),
    environmentNotice: asLiteral(record['environmentNotice'], ENVIRONMENT_NOTICE_IDS),
  };
}
