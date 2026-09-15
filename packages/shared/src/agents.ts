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
import type { TerminalActivity } from './models.js';
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
 *
 * Que un id este aca no quiere decir que el servidor lo lance: lo que viaja en
 * `hello` son los adaptadores **registrados**, y un id sin adaptador se trata
 * igual que una CLI no instalada. El orden es el de preferencia: con varias
 * instaladas, la que se abre por defecto sigue siendo la primera.
 */
export const AGENT_IDS = ['claude-code', 'codex', 'opencode', 'antigravity'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/**
 * Hito 28. De donde vienen las sesiones que existen **solo** en la copia
 * propia: historial huerfano de una herramienta sin adaptador, importado una
 * vez por un script.
 *
 * No son `AgentId`, y no por prolijidad: `AGENT_IDS` es "las CLIs con
 * adaptador", las que se lanzan, se ofrecen en el menu de pestana nueva y
 * reanudan una sesion. Un id de aca no hace nada de eso. Meterlo bajo uno
 * existente haria que "reanudar" buscara una sesion que esa CLI no tiene.
 *
 * Viven en este archivo y no en `vault.ts` porque `models.ts` los necesita en
 * tiempo de ejecucion para parsear `SessionSummary`, y `vault.ts` importa de
 * `models.ts`: al reves seria un ciclo de modulos.
 */
export const IMPORTED_AGENT_IDS = ['gemini-cli', 'antigravity-ide'] as const;
export type ImportedAgentId = (typeof IMPORTED_AGENT_IDS)[number];

/** De quien es una sesion de la barra. Un id importado no se lanza ni se reanuda. */
export type SessionAgentId = AgentId | ImportedAgentId;
export const SESSION_AGENT_IDS: readonly SessionAgentId[] = [...AGENT_IDS, ...IMPORTED_AGENT_IDS];

/**
 * Nombres para mostrar de las fuentes importadas. Son dato de compatibilidad
 * (regla 2.3), como las etiquetas que anuncia cada adaptador: ninguna funcion
 * ni pantalla del producto se llama asi.
 */
export const IMPORTED_AGENT_LABELS: Readonly<Record<ImportedAgentId, string>> = {
  'gemini-cli': 'Gemini CLI',
  'antigravity-ide': 'Antigravity IDE',
};

/** true si el id es de una CLI con adaptador: se puede lanzar y reanudar. */
export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** true si el id es de una fuente que solo existe en la copia propia. */
export function isImportedAgentId(value: string): value is ImportedAgentId {
  return (IMPORTED_AGENT_IDS as readonly string[]).includes(value);
}

/**
 * Como nombra la CLI una imagen adjunta por ruta.
 *
 *  - `at-quoted`: `@"ruta"` dentro del mismo pegado que el texto.
 *  - `bare-path-paste`: cada imagen en su propio pegado, con la ruta sola y
 *    antes del texto. Es para una CLI que adjunta solo si el pegado **entero**
 *    es la ruta de una imagen, y en la que `@` abre un buscador de archivos.
 */
export type ImageReferenceStyle = 'at-quoted' | 'bare-path-paste';
export const IMAGE_REFERENCE_STYLES: readonly ImageReferenceStyle[] = ['at-quoted', 'bare-path-paste'];

/** Como se menciona un archivo tecleandolo en la terminal. `at`: `@ruta `. */
export type FileMentionStyle = 'at';
export const FILE_MENTION_STYLES: readonly FileMentionStyle[] = ['at'];

/**
 * De donde sale la ventana de contexto.
 *
 *  - `usage-with-variants`: tokens por respuesta mas la variante resuelta
 *    (CLAUDE.md 4.5.1).
 *  - `token-count`: la CLI escribe la ventana exacta junto a los tokens, y la
 *    anuncia al empezar cada turno. No hay nada que reconstruir.
 *  - `usage-with-catalog`: tokens por respuesta mas el limite que da el
 *    catalogo de modelos de la propia CLI, por proveedor y modelo.
 *  - `status-line`: la CLI no escribe tokens en su historial y los publica
 *    solo por su status line, con la ventana exacta. Hace falta que el usuario
 *    la haya configurado; sin ella la CLI no declara ninguna fuente.
 */
export type ContextWindowSource =
  | 'usage-with-variants'
  | 'token-count'
  | 'usage-with-catalog'
  | 'status-line';
export const CONTEXT_WINDOW_SOURCES: readonly ContextWindowSource[] = [
  'usage-with-variants',
  'token-count',
  'usage-with-catalog',
  'status-line',
];

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
  /**
   * true si ciclar con una confirmacion pendiente **la aprueba**.
   *
   * Pasa con una CLI cuya documentacion dice que la tecla, con ediciones
   * esperando permiso, cambia de modo y las aprueba de paso. Ahi un clic en el
   * combo aprobaria algo que nadie leyo, y el cambio se rechaza mientras haya
   * una confirmacion abierta. Ausente al parsear es false: no invalida el ciclo.
   */
  approvesPendingOnCycle: boolean;
}

/**
 * Si la status line opcional de una CLI esta configurada, segun su
 * `settings.json`.
 *
 *  - `active`: apunta al script de la app y no esta desactivada.
 *  - `missing`: no hay archivo, no hay `statusLine` o no es un comando.
 *  - `other-command`: hay una status line, pero es otra.
 *  - `disabled`: es la de la app con `enabled: false`.
 *  - `unreadable`: el archivo existe y no es un objeto JSON.
 */
export type StatusLineState = 'active' | 'missing' | 'other-command' | 'disabled' | 'unreadable';
export const STATUS_LINE_STATES: readonly StatusLineState[] = [
  'active',
  'missing',
  'other-command',
  'disabled',
  'unreadable',
];

/**
 * Lo que muestra el dialogo de configuracion de la status line.
 *
 * Las dos rutas son **para mostrar**: viajan del servidor al navegador local,
 * como el `cwd` de un proyecto, y el cliente nunca las devuelve (CLAUDE.md 2.4).
 * La app no escribe el `settings.json` de la CLI: el usuario pega el fragmento.
 */
export interface StatusLineSetupInfo {
  state: StatusLineState;
  settingsPath: string;
  scriptPath: string;
  /**
   * El JSON que el usuario fusiona con su `settings.json`, o null si no hay uno
   * que funcione: en Windows la CLI corre la linea con `cmd /c` y ninguna
   * comilla llega viva al programa, asi que una carpeta con caracteres que
   * `cmd` interpreta no tiene fragmento posible. El dialogo dice por que.
   */
  fragment: string | null;
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
  /**
   * Mientras la CLI espera un permiso o una respuesta, el cuadro no manda y el
   * servidor rechaza el envio (hito 29, D12).
   *
   * Existe por la CLI cuyo menu de espera recibiria el pegado y su Enter como
   * teclas, y que ademas publica su estado: ahi el candado de una herramienta
   * sin resultado (CLAUDE.md 10.8) se apaga con `statusSource`, y sin esto no
   * quedaria ninguno. Hoy ninguna CLI lo declara.
   */
  waitingBlocksSubmit: boolean;
}

/**
 * true si la app no puede ver un menu de aprobacion abierto en esta pestana.
 *
 * Se decide por pestana y no por configuracion (R27-1 del hito 27): una CLI
 * que publica su estado solo si el usuario configuro algo puede tenerlo
 * configurado y no publicar nada —el script falla, `node` no esta en el PATH,
 * la CLI lo apago tras varios fallos—, y esa pestana sigue `unknown`. Ahi vale
 * lo mismo que sin fuente: una llamada sin resultado puede ser un menu. Con
 * Claude Code una pestana nunca esta `unknown`, asi que no cambia nada.
 *
 * `activity` es la de la pestana; null o ausente, no se sabe cual (sin
 * suscripcion): cuenta solo la capacidad.
 */
export function blindToApprovals(
  capabilities: Pick<AgentCapabilities, 'statusSource'>,
  activity: TerminalActivity | null = null,
): boolean {
  return !capabilities.statusSource || activity === 'unknown';
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
  waitingBlocksSubmit: false,
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
  /** Estado de la status line opcional; null para toda CLI que no la tenga. */
  statusLine: StatusLineSetupInfo | null;
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

  return { modes, launchMode, keyLabel, approvesPendingOnCycle: record['approvesPendingOnCycle'] === true };
}

/**
 * La status line de una CLI, o null.
 *
 * Todo o nada, como el ciclo: un dialogo con un estado que no se entiende o sin
 * la ruta que tiene que mostrar no puede decirle al usuario que hacer. Null
 * esconde el dialogo; no rompe la CLI.
 */
export function parseStatusLineSetupInfo(value: unknown): StatusLineSetupInfo | null {
  const record = asRecord(value);
  if (record === null) return null;

  const state = asLiteral(record['state'], STATUS_LINE_STATES);
  const settingsPath = asNonEmptyString(record['settingsPath']);
  const scriptPath = asNonEmptyString(record['scriptPath']);
  const rawFragment = record['fragment'];
  const fragment = rawFragment === null ? null : asNonEmptyString(rawFragment);
  if (
    state === null ||
    settingsPath === null ||
    scriptPath === null ||
    (rawFragment !== null && fragment === null)
  ) {
    return null;
  }
  return { state, settingsPath, scriptPath, fragment };
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
    waitingBlocksSubmit: record['waitingBlocksSubmit'] === true,
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
    statusLine: parseStatusLineSetupInfo(record['statusLine']),
  };
}
