/**
 * Lo que la interfaz dibuja segun la CLI de la pestana.
 *
 * Dos cosas distintas en el mismo archivo, y las dos por la misma razon:
 *
 *  - **Los datos de pantalla que son de cada CLI** (`AGENT_UI`): sus atajos
 *    dentro de la terminal y el archivo de instrucciones que carga sola. No
 *    viajan en `hello` porque no son capacidades medidas contra la CLI, son
 *    textos de esta interfaz.
 *  - **Las derivaciones de las capacidades**: que combo aparece, que solapa se
 *    ofrece, que dice un titulo. Viven aca y no repartidas en cada componente
 *    porque la web no tiene tests, y una capacidad mal traducida esconde un
 *    control sin que falle nada. Sin JSX, asi que `check-agent-registry.mjs`
 *    las importa y compara cada texto con el de antes, byte por byte.
 *
 * La regla de todo el archivo: con la CLI de hoy tiene que salir **exactamente**
 * lo que se veia antes de que existieran las capacidades.
 */

import {
  PERMISSION_MODE_HINT,
  PERMISSION_MODE_LABEL,
  modelOptionFor,
  normalizeCwdKey,
  type AgentCapabilities,
  type AgentId,
  type AgentInfo,
  type ContextUsage,
  type ContextWindowSource,
  type EffortOption,
  type ModelOption,
  type PermissionCycleCapability,
  type PermissionMode,
  type SessionSummary,
  type TerminalActivity,
  type TerminalDescriptor,
} from '@agent-workbench/shared';

export interface Shortcut {
  keys: string;
  description: string;
}

/** Lo que la pantalla sabe de una CLI y no le pregunta al servidor. */
export interface AgentUi {
  /**
   * Dos letras para la insignia de la pestana y de la fila de sesion, cuando
   * hay mas de una CLI. Cortas a proposito: una pestana encogida mide 44 px.
   */
  shortLabel: string;
  /** Las teclas de la CLI dentro de su terminal, para el dialogo de atajos. */
  shortcuts: readonly Shortcut[];
  /**
   * Una aclaracion debajo de los atajos, o null. Para las teclas que la CLI
   * tiene y que dentro de esta app no le llegan.
   */
  shortcutsNote: string | null;
  /** El archivo de instrucciones del proyecto que la CLI carga al arrancar. */
  instructionsFile: string;
}

/**
 * Las teclas de Codex dentro de su terminal.
 *
 * Salen del mapa de teclas de su fuente, no de una prueba: la prueba en vivo
 * del hito las confirma y lo que no funcione se saca de aca.
 */
const CODEX_SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Esc', description: 'Interrumpir el turno en curso' },
  { keys: 'Esc Esc', description: 'Editar un mensaje anterior' },
  { keys: 'Ctrl + C', description: 'Interrumpir, o salir si no hay turno' },
  { keys: 'Alt + , / Alt + .', description: 'Bajar / subir el esfuerzo' },
  {
    keys: 'Shift + Tab',
    description: 'Cambiar entre el modo por defecto y Plan (con el foco en la terminal)',
  },
  { keys: 'Tab', description: 'Encolar el mensaje mientras el agente trabaja' },
  { keys: 'Ctrl + T', description: 'Ver la transcripción' },
  { keys: 'Ctrl + R', description: 'Buscar en el historial de mensajes' },
  { keys: '@', description: 'Mencionar un archivo, una skill o un plugin' },
  { keys: '/', description: 'Comandos' },
  { keys: 'Ctrl + G', description: 'Editar el mensaje en el editor externo' },
];

/**
 * Una entrada por CLI con adaptador.
 *
 * Es un `Record` exhaustivo a proposito: agregar un id a `AGENT_IDS` sin su
 * entrada aca no compila, y asi el dialogo de atajos no queda mudo para la CLI
 * nueva sin que nadie lo note.
 */
export const AGENT_UI: Record<AgentId, AgentUi> = {
  'claude-code': {
    shortLabel: 'CC',
    shortcuts: [
      { keys: 'Esc', description: 'Interrumpir lo que la CLI esté haciendo' },
      { keys: 'Esc Esc', description: 'Abrir el menú de rewind' },
      { keys: 'Ctrl + C', description: 'Cancelar' },
      { keys: 'Ctrl + R', description: 'Buscar en el historial de comandos' },
      { keys: 'Ctrl + O', description: 'Ver la salida completa' },
      {
        keys: 'Shift + Tab',
        description: 'Cambiar el modo de permisos (con el foco en la terminal)',
      },
      { keys: 'Alt + V', description: 'Pegar una imagen del portapapeles' },
      { keys: 'Ctrl + V', description: 'Pegar texto del portapapeles' },
    ],
    shortcutsNote: null,
    instructionsFile: 'CLAUDE.md',
  },
  codex: {
    shortLabel: 'CX',
    shortcuts: CODEX_SHORTCUTS,
    shortcutsNote:
      'Alt + ← / → cambian de agente dentro de Codex, pero acá los usa la app para cambiar de pestaña.',
    instructionsFile: 'AGENTS.md',
  },
};

/** El archivo de instrucciones de una CLI, o null si la pestana no tiene. */
export function instructionsFileFor(agent: AgentId | null): string | null {
  return agent === null ? null : AGENT_UI[agent].instructionsFile;
}

/**
 * Los controles de la pestana activa, ya traducidos de las capacidades.
 *
 * `App.tsx` no lee `AgentCapabilities` campo por campo: lee esto. Asi la
 * traduccion es una sola y el chequeo la prueba entera.
 */
export interface AgentControlsView {
  /** El combo de modo, con su ciclo. null: no se dibuja. */
  modeCycle: PermissionCycleCapability | null;
  /** Opciones del combo de modelo. null: no se dibuja. */
  models: readonly ModelOption[] | null;
  /** Opciones del combo de esfuerzo. null: no se dibuja. */
  efforts: readonly EffortOption[] | null;
  /** El cuadro de escritura acepta imagenes pegadas o soltadas. */
  imagesAllowed: boolean;
  /** "Volver aqui" en los mensajes propios. */
  rewind: boolean;
  /** Las tarjetas de pregunta aceptan clics. */
  questionsAnswerable: boolean;
  /** "Insertar como @ruta" en el arbol de archivos. */
  fileMentions: boolean;
  /** La solapa Planes. */
  plansAvailable: boolean;
  /** De donde saca el medidor la ventana. null: no publica tokens. */
  contextWindowSource: ContextWindowSource | null;
  /** El boton de mandar una nota al agente. */
  noteSendable: boolean;
}

export function controlsFor(capabilities: AgentCapabilities): AgentControlsView {
  return {
    modeCycle: capabilities.permissionCycle,
    models: capabilities.models,
    efforts: capabilities.efforts,
    imagesAllowed: capabilities.imagesByPath !== null,
    rewind: capabilities.rewind,
    questionsAnswerable: capabilities.questionCards,
    fileMentions: capabilities.fileMentions !== null,
    plansAvailable: capabilities.plans,
    contextWindowSource: capabilities.contextWindowSource,
    // Mandar una nota abre una pestana y espera a que la CLI este lista antes
    // de pegar: sin esa senal, la pestana se abriria para nada.
    noteSendable: capabilities.readySignal,
  };
}

/**
 * La opcion del combo de modelo que corresponde a lo observado.
 *
 * Se casa igual que siempre (`modelOptionFor`), pero solo cuenta si la opcion
 * esta en la lista que declara la CLI: un valor que el combo no ofrece dejaria
 * el `select` apuntando a nada.
 */
export function modelOptionIn(
  models: readonly ModelOption[],
  observed: string | null,
): ModelOption | null {
  const option = modelOptionFor(observed);
  if (option === null) return null;
  return models.find((entry) => entry.value === option.value) ?? null;
}

/** Lo que muestra el combo de modo: lo observado, o con que se lanzo la pestana. */
export function shownMode(mode: PermissionMode | null, cycle: PermissionCycleCapability): PermissionMode {
  return mode ?? cycle.launchMode;
}

/** Titulo del combo de modo. La tecla la nombra la capacidad. */
export function modeTitle(mode: PermissionMode, cycle: PermissionCycleCapability): string {
  return `Modo ${PERMISSION_MODE_LABEL[mode]}: ${PERMISSION_MODE_HINT[mode]}. Cambiarlo manda ${cycle.keyLabel} a la pestaña CLI`;
}

/**
 * Las solapas que se ofrecen.
 *
 * Solo Planes depende de la CLI. Memoria no se filtra: la memoria compartida
 * es de la aplicacion y nombra CLIs que ni siquiera tienen adaptador.
 */
export function visiblePanelTabs<T extends { id: string }>(
  tabs: readonly T[],
  plansAvailable: boolean,
): T[] {
  return tabs.filter((tab) => plansAvailable || tab.id !== 'plans');
}

/**
 * La solapa que se muestra.
 *
 * La guardada no se pisa: si la pestana de ahora no tiene planes se muestra la
 * CLI, y al volver a una que si tiene, se vuelve a Planes.
 */
export function effectivePanelTab<T extends string>(tab: T, plansAvailable: boolean): T | 'cli' {
  return tab === 'plans' && !plansAvailable ? 'cli' : tab;
}

/**
 * De que CLI habla el dialogo de atajos.
 *
 * La de la pestana activa; sin pestana, la que se usaria para abrir una; y si
 * no hay ninguna instalada, la primera registrada. Sin ese ultimo respaldo,
 * abrir el dialogo con la CLI ausente perderia la seccion de la terminal, que
 * antes se dibujaba siempre.
 */
export function shortcutsAgent(
  active: AgentId | null,
  agents: readonly AgentInfo[],
  defaultAgent: AgentId | null,
): AgentInfo | null {
  const byId = (id: AgentId | null): AgentInfo | undefined =>
    id === null ? undefined : agents.find((agent) => agent.id === id);
  return byId(active) ?? byId(defaultAgent) ?? agents[0] ?? null;
}

/**
 * Las teclas del cuadro de escritura.
 *
 * `Ctrl+V` nombra la imagen solo si la CLI la recibe: el cuadro de una que no
 * la recibe la rechaza al pegar, y el dialogo no puede prometerla.
 */
export function composerShortcuts(imagesAllowed: boolean): readonly Shortcut[] {
  return [
    { keys: 'Enter', description: 'Enviar el mensaje' },
    { keys: 'Shift + Enter', description: 'Salto de línea sin enviar' },
    {
      keys: 'Ctrl + V',
      description: imagesAllowed
        ? 'Pegar texto o una imagen (queda como miniatura)'
        : 'Pegar texto',
    },
    { keys: 'Esc', description: 'Interrumpir lo que la CLI esté haciendo' },
  ];
}

/** Lo que dice el cuadro cuando se le pega una imagen que la CLI no recibe. */
export const IMAGES_REFUSED_MESSAGE = 'Esta CLI no recibe imagenes desde el cuadro.';

/**
 * El limite que el medidor muestra antes de la primera respuesta, o null.
 *
 * Primero lo que declara la configuracion. Si no declara nada, una CLI que
 * escribe la ventana exacta al empezar el turno ya la dijo antes de responder,
 * y ese numero no hay que adivinarlo. Con cualquier otra fuente, lo que traiga
 * el uso antes de medir no es un dato publicado y no se muestra.
 */
export function meterIdleWindow(
  source: ContextWindowSource | null,
  usage: Pick<ContextUsage, 'contextWindow'>,
  fallbackWindow: number | null,
): number | null {
  return fallbackWindow ?? (source === 'token-count' ? usage.contextWindow : null);
}

/** Titulo del medidor antes de la primera respuesta. */
export function meterIdleDetail(instructionsFile: string | null): string {
  const instructions = instructionsFile ?? 'archivo de instrucciones del proyecto';
  return (
    'La sesion todavia no midio ninguna respuesta. No arranca en cero: el prompt de' +
    ` sistema, las herramientas y el ${instructions} ya ocupan contexto, y el numero real` +
    ' aparece con la primera respuesta.'
  );
}

/** Titulo del punto de una pestana con proceso que no esta ni trabajando ni esperando. */
export function restingDotTitle(activity: TerminalActivity | undefined): string {
  if (activity === 'idle') return 'Lista, sin nada en curso';
  if (activity === 'unknown') return 'Esta CLI no publica su estado';
  return 'CLI abierta';
}

/**
 * true si una sesion del historial se puede retomar desde la barra.
 *
 * Antes del `hello` no se sabe nada y vale lo de siempre: arrancar con la
 * barra apagada hasta conectar seria un parpadeo.
 */
export function sessionResumable(agents: readonly AgentInfo[], agent: AgentId): boolean {
  if (agents.length === 0) return true;
  return agents.some(
    (info) => info.id === agent && info.available && info.capabilities.resume,
  );
}

/** Titulo del boton de mandar una nota al agente. */
export function noteSendTitle(
  sendable: boolean,
  targetCwd: string | null,
  empty: boolean,
): string {
  if (!sendable) {
    return targetCwd === null
      ? 'Abri una pestana primero: la conversacion se abre en su proyecto'
      : 'La CLI de esta pestaña no avisa cuando esta lista, asi que la nota no se puede mandar';
  }
  return empty
    ? 'La nota esta vacia'
    : `Mandar la nota al agente en una conversacion nueva de ${targetCwd ?? ''}`;
}

// ---------------------------------------------------------------------------
// Elegir CLI: el boton partido, el menu y las insignias (hito 25)
// ---------------------------------------------------------------------------
//
// Todo esto se dibuja solo con mas de una CLI disponible (`offerAgentChoice`).
// Con una sola, los botones son los de siempre y abren sin nombrar ninguna: la
// decide el servidor, igual que antes.

/**
 * La CLI de la **ultima** pestana de agente de ese proyecto, o null.
 *
 * La misma regla que `resolveAgentForOpen` del servidor, que es la que usa
 * `Alt+T`: el proyecto se compara por clave normalizada, con la plataforma del
 * servidor, y las consolas no cuentan. Que el boton diga la misma CLI que va a
 * abrir el atajo es lo que hace que los dos no se contradigan.
 */
export function lastAgentFor(
  terminals: readonly Pick<TerminalDescriptor, 'kind' | 'agent' | 'cwd'>[],
  cwd: string,
  platform: string,
): AgentId | null {
  const key = normalizeCwdKey(cwd, platform);
  let found: AgentId | null = null;
  for (const terminal of terminals) {
    if (terminal.kind !== 'agent' || terminal.agent === null) continue;
    if (normalizeCwdKey(terminal.cwd, platform) === key) found = terminal.agent;
  }
  return found;
}

/**
 * La primera candidata que esta instalada, o la primera instalada si ninguna.
 *
 * Una pestana puede ser de una CLI que ya no esta —se desinstalo con la app
 * abierta—, y ofrecer abrir con esa es ofrecer un error.
 */
export function firstAvailableAgent(
  candidates: readonly (AgentId | null)[],
  agents: readonly AgentInfo[],
): AgentId | null {
  const available = agents.filter((agent) => agent.available);
  for (const candidate of candidates) {
    if (candidate !== null && available.some((agent) => agent.id === candidate)) return candidate;
  }
  return available[0]?.id ?? null;
}

/** La CLI de la sesion mas reciente, o null sin sesiones. */
export function latestSessionAgent(
  sessions: readonly Pick<SessionSummary, 'agent' | 'updatedAt'>[],
): AgentId | null {
  let latest: Pick<SessionSummary, 'agent' | 'updatedAt'> | null = null;
  for (const session of sessions) {
    if (latest === null || session.updatedAt > latest.updatedAt) latest = session;
  }
  return latest?.agent ?? null;
}

/**
 * Con que CLI abre el `+` de la barra de pestanas, y cual resalta su menu.
 *
 * La del ultimo trabajo en ese proyecto, o la de por defecto: la regla de
 * `Alt+T`. El boton partido existe para que quien trabaja siempre con la misma
 * no pague un clic mas por tener otra instalada (M6).
 */
export function tabBarAgent(
  terminals: readonly Pick<TerminalDescriptor, 'kind' | 'agent' | 'cwd'>[],
  cwd: string,
  platform: string,
  agents: readonly AgentInfo[],
  defaultAgent: AgentId | null,
): AgentId | null {
  return firstAvailableAgent([lastAgentFor(terminals, cwd, platform), defaultAgent], agents);
}

/**
 * Con que CLI abre el `+` de un proyecto de la barra lateral.
 *
 * Como el de la barra de pestanas, pero antes de la de por defecto mira el
 * historial del proyecto: sin pestanas abiertas ahi, la sesion mas reciente
 * dice con que CLI se trabajo por ultima vez.
 */
export function projectAgent(
  terminals: readonly Pick<TerminalDescriptor, 'kind' | 'agent' | 'cwd'>[],
  project: { cwd: string; sessions: readonly Pick<SessionSummary, 'agent' | 'updatedAt'>[] },
  platform: string,
  agents: readonly AgentInfo[],
  defaultAgent: AgentId | null,
): AgentId | null {
  return firstAvailableAgent(
    [lastAgentFor(terminals, project.cwd, platform), latestSessionAgent(project.sessions), defaultAgent],
    agents,
  );
}

/** Lo que ofrece el menu: las instaladas, en el orden en que se registraron. */
export function menuAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.available);
}

/** Donde arranca el resaltado del menu: la preelegida, o la primera. */
export function menuStartIndex(items: readonly AgentInfo[], preselected: AgentId | null): number {
  const index = items.findIndex((agent) => agent.id === preselected);
  return index === -1 ? 0 : index;
}

/** Mover el resaltado con las flechas. Da la vuelta en los dos extremos. */
export function menuStep(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * Donde se dibuja el menu: debajo del boton, alineado a su borde izquierdo.
 *
 * Si abajo no entra, arriba; si por la derecha se sale, se corre hacia adentro.
 * Nunca por fuera de la ventana: un menu cortado esconde justo la opcion que
 * uno viene a elegir.
 */
export function menuPlacement(
  anchor: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 4,
): { left: number; top: number } {
  const below = anchor.bottom + 2;
  const above = anchor.top - 2 - menu.height;
  const top =
    below + menu.height + margin <= viewport.height || above < margin
      ? Math.max(margin, Math.min(below, viewport.height - menu.height - margin))
      : above;
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - menu.width - margin));
  return { left, top };
}

/** La insignia de una pestana: solo si hay para elegir, y si la pestana tiene CLI. */
export function tabBadgeVisible(offerAgentChoice: boolean, agent: AgentId | null): boolean {
  return offerAgentChoice && agent !== null;
}

/** Lo que muestra una fila de sesion de la barra lateral sobre su CLI. */
export interface SessionAgentView {
  /** Dibujar la insignia con la CLI. */
  badge: boolean;
  /** Titulo de la fila cuando su CLI no esta instalada, o null. */
  unavailableTitle: string | null;
}

/**
 * La insignia y el aviso de una fila de sesion.
 *
 * Con mas de una CLI disponible, todas llevan insignia. Con una sola, solo las
 * de una CLI que no esta: son las que no se abren, y sin la insignia no se
 * sabe por que. Sin **ninguna** instalada no se marca nada fila por fila: la
 * barra entera esta apagada y el cartel de arriba ya lo explica, que es lo que
 * se veia antes de que hubiera dos.
 */
export function sessionAgentView(
  agent: AgentId,
  agents: readonly AgentInfo[],
  offerAgentChoice: boolean,
): SessionAgentView {
  const info = agents.find((entry) => entry.id === agent);
  const anyAvailable = agents.some((entry) => entry.available);
  const missing = info !== undefined && !info.available && anyAvailable;
  return {
    badge: offerAgentChoice || missing,
    unavailableTitle: missing ? `La CLI ${info.label} no está instalada.` : null,
  };
}

/**
 * true si la pestana todavia no sabe su sesion y la va a ganar con el primer
 * mensaje: una CLI que pone el id ella misma. Con una que lo fija al lanzar,
 * una pestana sin sesion no espera nada.
 */
export function discoveringSession(
  agent: AgentId | null,
  sessionId: string,
  capabilities: AgentCapabilities,
): boolean {
  return agent !== null && sessionId === '' && !capabilities.sessionIdAtLaunch;
}

/** La linea que la vista vacia agrega mientras la sesion no aparece. */
export const DISCOVERING_HINT = 'La sesión aparece en el historial con el primer mensaje.';

/**
 * Por que el cuadro de escritura no deja mandar, o null si deja.
 *
 * Una CLI que no publica su estado puede tener un menu de aprobacion abierto
 * sin que la app lo sepa, y lo unico que se ve es una llamada a herramienta
 * sin resultado. Un mensaje mandado ahi llega como teclas al menu: el Enter
 * final aprueba. El servidor lo rechaza igual; esto lo dice antes (A1).
 *
 * Solo con la CLI viva: sin proceso el cuadro ya esta apagado por otra razon.
 */
export function openToolCallNotice(
  capabilities: AgentCapabilities,
  openToolCall: boolean,
  label: string | null,
  alive: boolean,
): string | null {
  if (!alive || capabilities.statusSource || !openToolCall) return null;
  return `${label ?? 'La CLI'} tiene una herramienta sin resultado: puede estar pidiendo una aprobación. Contestala en la solapa CLI.`;
}
