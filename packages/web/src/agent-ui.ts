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
  IMPORTED_AGENT_LABELS,
  PERMISSION_MODE_HINT,
  PERMISSION_MODE_LABEL,
  blindToApprovals,
  isAgentId,
  modelOptionFor,
  normalizeCwdKey,
  shouldOfferAgentChoice,
  type AgentCapabilities,
  type AgentId,
  type AgentInfo,
  type ImportedAgentId,
  type SessionAgentId,
  type ContextUsage,
  type ContextWindowSource,
  type EffortOption,
  type ModelOption,
  type PermissionCycleCapability,
  type PermissionMode,
  type SessionSummary,
  type StatusLineSetupInfo,
  type StatusLineState,
  type TerminalActivity,
  type TerminalDescriptor,
  type TerminalId,
  type TerminalOfflineReason,
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
  /**
   * true si `/model` y `/effort` dejan lo elegido como predeterminado de la CLI,
   * tambien para las pestanas siguientes. Lo dice el titulo de los combos:
   * cambiar el modelo de una pestana no deberia sorprender en la proxima.
   */
  savesModelChoice: boolean;
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
 * Las teclas de OpenCode dentro de su terminal.
 *
 * Salen de las cadenas del binario de la 1.18.30, salvo el lider `Ctrl + X`, que
 * es el valor documentado y no se leyo ahi: la prueba en vivo del hito lo
 * confirma o se corrige este texto.
 *
 * El salto de linea es `Ctrl + J` y no `Shift + Enter`, aunque el binario
 * declare los dos: xterm manda el mismo `\r` con Shift o sin el, y OpenCode lo
 * toma como un Enter y envia el mensaje a medias. `Ctrl + J` llega como `\n`.
 */
const OPENCODE_SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Esc Esc', description: 'Interrumpir (el primer toque sólo avisa)' },
  {
    keys: 'Tab / Shift + Tab',
    description: 'Cambiar de agente, build o plan (con el foco en la terminal)',
  },
  { keys: 'Ctrl + P', description: 'Lista de comandos, con las variantes del modelo' },
  { keys: 'Ctrl + X y M', description: 'Elegir modelo' },
  {
    keys: 'Ctrl + X y N',
    description: 'Sesión nueva: la pestaña sigue atada a la sesión con la que se abrió',
  },
  { keys: 'Ctrl + J', description: 'Salto de línea' },
  { keys: 'Ctrl + C', description: 'Limpiar la entrada; dos veces, salir' },
  { keys: 'Ctrl + V', description: 'Pegar' },
];

/**
 * Las teclas de Antigravity CLI dentro de su terminal.
 *
 * Solo las medidas en vivo con la 1.2.2 (hito 27, paso 0): un Esc interrumpe,
 * `Shift + Tab` cicla los tres modos, y el menu de permiso es numerado —no
 * `y`/`n` como decia la documentacion—. Lo que no se probo no se lista.
 */
const ANTIGRAVITY_SHORTCUTS: readonly Shortcut[] = [
  { keys: 'Esc', description: 'Interrumpir el turno en curso, o cancelar un pedido de permiso' },
  {
    keys: 'Shift + Tab',
    description: 'Cambiar el modo: accept-edits, plan y por defecto (con el foco en la terminal)',
  },
  { keys: '1 … 4', description: 'Contestar un pedido de permiso: 1 lo permite, 4 lo rechaza' },
  { keys: '/', description: 'Comandos' },
  { keys: '?', description: 'Ver los atajos de la CLI' },
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
    savesModelChoice: false,
  },
  codex: {
    shortLabel: 'CX',
    shortcuts: CODEX_SHORTCUTS,
    shortcutsNote:
      'Alt + ← / → cambian de agente dentro de Codex, pero acá los usa la app para cambiar de pestaña.',
    instructionsFile: 'AGENTS.md',
    savesModelChoice: false,
  },
  opencode: {
    shortLabel: 'OC',
    shortcuts: OPENCODE_SHORTCUTS,
    shortcutsNote:
      'Ctrl + T cambia la variante del modelo dentro de OpenCode, pero el navegador se la queda: está en Ctrl + P.',
    instructionsFile: 'AGENTS.md',
    savesModelChoice: false,
  },
  antigravity: {
    shortLabel: 'AG',
    shortcuts: ANTIGRAVITY_SHORTCUTS,
    shortcutsNote: null,
    instructionsFile: 'AGENTS.md',
    // Medido con la 1.2.2: los dos quedan escritos en su settings.json.
    savesModelChoice: true,
  },
};

/**
 * Las dos letras de las fuentes importadas a la copia propia (hito 28).
 *
 * Aparte de `AGENT_UI` porque no son CLIs de la app: no tienen atajos, ni
 * archivo de instrucciones, ni pestanas. Solo filas en la barra.
 */
export const IMPORTED_AGENT_SHORT_LABELS: Record<ImportedAgentId, string> = {
  'gemini-cli': 'GC',
  'antigravity-ide': 'AI',
};

/** Las dos letras de la insignia, de una CLI o de una fuente importada. */
export function agentShortLabel(agent: SessionAgentId): string {
  return isAgentId(agent) ? AGENT_UI[agent].shortLabel : IMPORTED_AGENT_SHORT_LABELS[agent];
}

/**
 * El nombre para mostrar de quien escribio una sesion.
 *
 * De una CLI, el que anuncia el servidor (y el id si todavia no lo anuncio);
 * de una fuente importada, el de `IMPORTED_AGENT_LABELS`, que no viaja en
 * `hello` porque no hay adaptador que la anuncie.
 */
export function sessionAgentLabel(agent: SessionAgentId, agents: readonly AgentInfo[]): string {
  if (!isAgentId(agent)) return IMPORTED_AGENT_LABELS[agent];
  return agents.find((info) => info.id === agent)?.label ?? agent;
}

/**
 * true si una fila de la barra se retoma como pestana: es del historial nativo
 * y de una CLI con adaptador.
 *
 * Una importada no tiene CLI con que reanudarse, y una que solo esta en la
 * copia propia (`storage 'vault'`) ya no existe para su CLI: reanudarla abriria
 * una pestana con un error. Estrecha el tipo para quien lanza.
 */
export function resumableSession<T extends Pick<SessionSummary, 'agent' | 'storage'>>(
  session: T,
): session is T & { agent: AgentId } {
  return session.storage === 'native' && isAgentId(session.agent);
}

/** Lo que agregan los titulos de los combos de modelo y esfuerzo, o '' si nada. */
export function modelChoiceNote(agent: AgentId | null): string {
  return agent !== null && AGENT_UI[agent].savesModelChoice
    ? ', y la CLI lo guarda como predeterminado para las pestañas siguientes'
    : '';
}

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
 * Se casa igual que siempre (`modelOptionFor`), pero contra la lista que
 * declara la CLI y solo si la opcion esta en ella: un valor que el combo no
 * ofrece dejaria el `select` apuntando a nada. Con la lista de Claude Code es
 * el resultado de siempre; con la de otra CLI (hito 27) casa por sus familias.
 */
export function modelOptionIn(
  models: readonly ModelOption[],
  observed: string | null,
): ModelOption | null {
  const option = modelOptionFor(observed, models);
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
 * true si el combo de modo no deja cambiar: la tecla de la CLI aprueba lo
 * pendiente al ciclar (`approvesPendingOnCycle`) y la CLI dice que espera algo.
 * El servidor lo rechaza igual (`planModeChange`); esto lo dice antes.
 */
export function modeChangeBlocked(cycle: PermissionCycleCapability, waitingFor: string | null): boolean {
  return cycle.approvesPendingOnCycle && waitingFor !== null;
}

/**
 * Titulo completo del combo de modo, con lo que agrega una CLI cuya tecla
 * aprueba lo pendiente (hito 27). Con Claude Code es `modeTitle` tal cual.
 *
 * `statusKnown`: la app ve el estado de **esta pestana**
 * (`!blindToApprovals(capabilities, actividad)`). No alcanza con que la CLI lo
 * publique: con la status line configurada y sin publicar nada la pestana
 * sigue `unknown` (R27-1). Sin eso la app no ve una confirmacion abierta, no
 * puede frenar el cambio, y lo unico honesto es avisarlo.
 */
export function modeControlTitle(
  mode: PermissionMode,
  cycle: PermissionCycleCapability,
  statusKnown: boolean,
  waitingFor: string | null,
): string {
  if (modeChangeBlocked(cycle, waitingFor)) {
    return 'Hay una confirmación pendiente en la CLI: cambiar de modo ahora la aprobaría. Contestala en la solapa CLI.';
  }
  const base = modeTitle(mode, cycle);
  if (!cycle.approvesPendingOnCycle || statusKnown) return base;
  return `${base}. Sin datos de la status line la app no sabe si hay una confirmación pendiente; cambiar el modo en ese momento la aprueba`;
}

/** Lo que dice el dialogo de la status line sobre su estado, en una linea. */
export function statusLineStateText(state: StatusLineState): string {
  switch (state) {
    case 'active':
      return 'Configurada';
    case 'missing':
      return 'No configurada';
    case 'other-command':
      return 'Tenés otra status line: pegar esta la reemplaza';
    case 'disabled':
      return 'Desactivada (enabled: false)';
    case 'unreadable':
      return 'No pude leer settings.json';
  }
}

/** Por que el dialogo no ofrece fragmento (`StatusLineSetupInfo.fragment` null). */
export const STATUS_LINE_NO_FRAGMENT =
  'La carpeta de la app tiene caracteres que la consola interpreta (como & % ! o comillas), y con ellos no hay una línea que la CLI pueda correr: en Windows la corre con cmd /c y ninguna comilla le llega. Con la carpeta de configuración en una ruta sin esos caracteres se resuelve.';

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
 * y ese numero no hay que adivinarlo. Lo mismo la que la publica por su status
 * line (hito 27, B6): la ventana llega exacta antes que los tokens. Con
 * cualquier otra fuente, lo que traiga el uso antes de medir no es un dato
 * publicado y no se muestra.
 */
export function meterIdleWindow(
  source: ContextWindowSource | null,
  usage: Pick<ContextUsage, 'contextWindow'>,
  fallbackWindow: number | null,
): number | null {
  return (
    fallbackWindow ??
    (source === 'token-count' || source === 'status-line' ? usage.contextWindow : null)
  );
}

/**
 * true si el medidor ya tiene un numero que mostrar.
 *
 * Con las fuentes que leen el historial, desde la primera respuesta (regla 3
 * del medidor). Con la status line no depende de las respuestas: el numero es
 * lo que la CLI publico, y hasta que lo publica —una conversacion reanudada
 * antes de que corra, o una recien limpiada— no hay nada que medir aunque el
 * hilo tenga mensajes. Dibujar ahi un 0 afirmaria que la ventana esta libre.
 */
export function meterMeasured(
  source: ContextWindowSource | null,
  usage: Pick<ContextUsage, 'assistantMessages' | 'lastRequestTokens'>,
): boolean {
  if (source === 'status-line') return usage.lastRequestTokens > 0;
  return usage.assistantMessages > 0;
}

/**
 * true si el medidor de una CLI sin tokens ofrece configurar su status line:
 * la CLI la tiene (`AgentInfo.statusLine`) y no esta activa. Con la status
 * line activa la fuente ya no es null y el medidor mide.
 */
export function meterOffersSetup(
  source: ContextWindowSource | null,
  statusLine: Pick<StatusLineSetupInfo, 'state'> | null,
): boolean {
  return source === null && statusLine !== null && statusLine.state !== 'active';
}

/** Titulo del medidor que ofrece configurar la status line. */
export function meterSetupTitle(state: StatusLineState): string {
  const why =
    state === 'other-command'
      ? 'tenés otra status line configurada'
      : state === 'disabled'
        ? 'la status line de la app está desactivada'
        : state === 'unreadable'
          ? 'no se pudo leer su settings.json'
          : 'todavía no está configurada';
  return `Esta CLI publica sus tokens solo por su status line, y ${why}. Configurar explica cómo.`;
}

/**
 * De donde sale el limite que dibuja el medidor, para su titulo, o null si no
 * hace falta decirlo.
 *
 * Una cota deducida de los tokens se dice siempre (regla 4 del medidor). Un
 * limite del catalogo de modelos de la CLI tambien: no es la ventana que la CLI
 * uso, es la que su catalogo dice que tiene ese modelo en ese proveedor.
 */
export function meterWindowOrigin(
  source: ContextWindowSource | null,
  usage: Pick<ContextUsage, 'contextWindow' | 'contextWindowEstimated'>,
): string | null {
  if (usage.contextWindowEstimated) return 'limite deducido de los tokens medidos';
  if (source === 'usage-with-catalog' && usage.contextWindow !== null) {
    return 'limite del catalogo de modelos de la CLI';
  }
  return null;
}

/**
 * Titulo del medidor antes de la primera respuesta.
 *
 * Con la status line (hito 27) el numero no espera una respuesta sino que la
 * CLI la corra con esta conversacion, y se dice eso.
 */
export function meterIdleDetail(
  instructionsFile: string | null,
  source: ContextWindowSource | null = null,
): string {
  if (source === 'status-line') {
    return (
      'La status line todavia no publico tokens de esta conversacion. No arranca en cero: el' +
      ' numero aparece cuando la CLI la corre, con el primer mensaje o al retomar la sesion.'
    );
  }
  const instructions = instructionsFile ?? 'archivo de instrucciones del proyecto';
  return (
    'La sesion todavia no midio ninguna respuesta. No arranca en cero: el prompt de' +
    ` sistema, las herramientas y el ${instructions} ya ocupan contexto, y el numero real` +
    ' aparece con la primera respuesta.'
  );
}

/**
 * Titulo del punto de una pestana con proceso que no esta ni trabajando ni esperando.
 *
 * `statusLine`: la de la CLI de la pestana, si tiene una opcional (hito 27).
 * Ahi `unknown` no es que la CLI no publique nada: publica solo con la status
 * line, o todavia no publico nada de esta conversacion.
 */
export function restingDotTitle(
  activity: TerminalActivity | undefined,
  statusLine: Pick<StatusLineSetupInfo, 'state'> | null = null,
): string {
  if (activity === 'idle') return 'Lista, sin nada en curso';
  if (activity === 'unknown') {
    if (statusLine === null) return 'Esta CLI no publica su estado';
    return statusLine.state === 'active'
      ? 'La status line todavía no publicó el estado de esta conversación'
      : 'Esta CLI publica su estado sólo con la status line configurada';
  }
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

/**
 * La CLI de la sesion mas reciente, o null sin sesiones.
 *
 * Las de una fuente importada no cuentan: no hay CLI con que abrir el `+` por
 * ellas, y un proyecto donde lo ultimo es un rescate sigue abriendo con la CLI
 * de la sesion nativa anterior.
 */
export function latestSessionAgent(
  sessions: readonly Pick<SessionSummary, 'agent' | 'updatedAt'>[],
): AgentId | null {
  let latest: { agent: AgentId; updatedAt: number } | null = null;
  for (const session of sessions) {
    const agent = session.agent;
    if (!isAgentId(agent)) continue;
    if (latest === null || session.updatedAt > latest.updatedAt) latest = { agent, updatedAt: session.updatedAt };
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

/** Lo unico que el menu usa de un nodo del DOM para decidir si un scroll lo cierra. */
export interface MenuScrollNode {
  contains(other: unknown): boolean;
}

/**
 * Si un scroll cierra el menu: solo el de algo que puede mover el boton que lo
 * abrio —el documento o un ancestro suyo—, y nunca el del propio menu.
 *
 * Hito 29, medido en la prueba en vivo: con texto largo en el filtro de la
 * barra, el clic en `↪` de una fila le saca el foco al campo, Chrome devuelve su
 * scroll horizontal a cero y ese scroll cerraba el menu recien abierto. El
 * primer clic no hacia nada. El scroll interno de un campo de texto no mueve
 * nada de lo que hay alrededor. Un destino desconocido cierra, como antes.
 */
export function scrollClosesMenu(
  scrolled: unknown,
  anchor: unknown,
  menu: MenuScrollNode | null,
): boolean {
  const node = scrolled as Partial<MenuScrollNode> | null;
  if (node === null || typeof node !== 'object' || typeof node.contains !== 'function') return true;
  if (menu !== null && menu.contains(scrolled)) return false;
  return node.contains(anchor);
}

// ---------------------------------------------------------------------------
// Continuar en otra CLI (hito 29)
// ---------------------------------------------------------------------------

/**
 * Con que CLIs se puede continuar una conversacion: las instaladas salvo la de
 * origen, en orden de registro.
 *
 * `[]` —y entonces no se dibuja ningun `↪`— si no hay mas de una instalada
 * (D21): quien usa una sola CLI no ve nada nuevo. Tambien con una sesion
 * `partial`: el rescate del IDE (hito 28) no trae ningun mensaje, y el servidor
 * la rechazaria igual con "no tiene mensajes que continuar" (B9).
 */
export function continueTargets(
  agents: readonly AgentInfo[],
  source: SessionAgentId | null,
  partial = false,
): AgentInfo[] {
  if (source === null || partial || !shouldOfferAgentChoice(agents)) return [];
  return menuAgents(agents).filter((agent) => agent.id !== source);
}

/** Titulo del `↪`, en la fila y en el medidor. */
export const CONTINUE_BUTTON_TITLE = 'Continuar esta conversación con otra CLI';

/**
 * Por que el `↪` del medidor esta apagado, o null si no lo esta.
 *
 * `hasMessages` es si el hilo de la pestana tiene algun evento (R29-5): una
 * pestana nueva de Claude Code tiene id desde el lanzamiento, pero su archivo no
 * existe hasta el primer mensaje, y el servidor contestaba que la conversacion
 * no esta en el historial.
 */
export function continueBlockedReason(sessionId: string, discovering: boolean, hasMessages: boolean): string | null {
  if (discovering) return 'La sesión todavía no está en el historial: aparece con el primer mensaje.';
  if (sessionId.length === 0) return 'Esta pestaña todavía no tiene una conversación que continuar.';
  if (!hasMessages) return 'Esta conversación todavía no tiene mensajes que continuar.';
  return null;
}

/**
 * El aviso encima del cuadro de una pestana que continua otra conversacion.
 * Dice lo que se pierde: el agente no tiene el contexto de la otra CLI, tiene un
 * recorte (D16).
 */
export function handoffNoticeText(
  label: string,
  includedTurns: number,
  totalTurns: number,
  totalTurnsIsMinimum: boolean,
): string {
  const of = totalTurnsIsMinimum ? `de más de ${totalTurns}` : `de ${totalTurns}`;
  const turns =
    includedTurns >= totalTurns && !totalTurnsIsMinimum
      ? totalTurns === 1
        ? 'del único turno'
        : `de los ${totalTurns} turnos`
      : includedTurns === 1
        ? `del último turno ${of}`
        : `de los últimos ${includedTurns} ${of} turnos`;
  return `Continuación de ${label}: el agente arranca de un transcript ${turns}, no del contexto que tenía. Los resultados de herramientas van recortados y las imágenes no viajan.`;
}

/** Lo que agrega el aviso mientras el servidor manda la continuacion sola. */
export const HANDOFF_SENDING_TEXT = 'Mandando la continuación…';

/** Lo que agrega el aviso cuando la continuacion no se mando sola y quedo en el cuadro. */
export function handoffPrefillText(reason: 'no-delivery' | 'not-ready' | 'send-failed'): string {
  switch (reason) {
    case 'no-delivery':
      return 'El mensaje quedó en el cuadro: revisalo y mandalo con Enter.';
    case 'not-ready':
      return 'La CLI no llegó a estar lista a tiempo: el mensaje quedó en el cuadro para que lo mandes.';
    case 'send-failed':
      return 'No se pudo mandar solo: el mensaje quedó en el cuadro para que lo mandes.';
  }
}

/**
 * Como queda el borrador de una pestana cuando llega un texto prellenado: el
 * texto solo si estaba vacio; si no, antes de lo escrito y separado por una
 * linea en blanco. Nunca se pisa lo que el usuario escribio.
 */
export function mergePrefill(draft: string, prefill: string): string {
  return draft.trim().length === 0 ? prefill : `${prefill}\n\n${draft}`;
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
 *
 * Una fila de una fuente importada (hito 28) lleva insignia siempre, tambien
 * con una sola CLI: sin ella se confundiria con una sesion de esa CLI. Y
 * nunca el aviso de "no esta instalada": no hay nada que instalar.
 */
export function sessionAgentView(
  agent: SessionAgentId,
  agents: readonly AgentInfo[],
  offerAgentChoice: boolean,
): SessionAgentView {
  if (!isAgentId(agent)) return { badge: true, unavailableTitle: null };
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

/**
 * Lo que dice el hilo de una conversacion que existe pero no dejo nada legible
 * que seguir (`ConversationState 'no-transcript'`, hito 27): una version vieja
 * de la CLI que guardaba el historial vacio. Se lista y se puede reanudar.
 */
export const NO_TRANSCRIPT_TEXT =
  'Esta conversación es de una versión de la CLI que no dejaba el transcript legible. Se puede reanudar desde la barra lateral, pero acá no hay nada que mostrar.';

/** La linea que la vista vacia agrega mientras la sesion no aparece. */
export const DISCOVERING_HINT = 'La sesión aparece en el historial con el primer mensaje.';

/**
 * Por que el cuadro de escritura no deja mandar, o null si deja.
 *
 * Una pestana cuyo estado no se ve puede tener un menu de aprobacion abierto
 * sin que la app lo sepa, y lo unico que se ve es una llamada a herramienta
 * sin resultado. Un mensaje mandado ahi llega como teclas al menu: el Enter
 * final aprueba. El servidor lo rechaza igual; esto lo dice antes (A1).
 *
 * "No se ve" es por pestana (`blindToApprovals`, R27-1): `activity` es la de
 * la pestana; sin ella cuenta solo la capacidad, como antes.
 *
 * Solo con la CLI viva: sin proceso el cuadro ya esta apagado por otra razon.
 */
export function openToolCallNotice(
  capabilities: AgentCapabilities,
  openToolCall: boolean,
  label: string | null,
  alive: boolean,
  activity: TerminalActivity | null = null,
): string | null {
  if (!alive || !blindToApprovals(capabilities, activity) || !openToolCall) return null;
  return `${label ?? 'La CLI'} tiene una herramienta sin resultado: puede estar pidiendo una aprobación. Contestala en la solapa CLI.`;
}

/**
 * Lo que dice la barra de "esperando una respuesta": el permiso se nombra, el
 * resto se agrupa. Una sola copia para la barra y para el cuadro que se apaga
 * por ella (`pendingApprovalNotice`).
 */
export function waitingBarText(waitingFor: string, questionsAnswerable = false): string {
  if (waitingFor === 'permission prompt') return 'La CLI esta esperando que autorices una herramienta.';
  /*
    Hito 29 (B6): una CLI que publica que espera la respuesta a una pregunta
    —`'question'`— y cuyas tarjetas se contestan desde el hilo. Ahi la barra no
    manda a la solapa CLI: la tarjeta con los botones esta arriba. Ninguna CLI
    de hoy publica esa etiqueta, y con cualquier otra el texto es el de siempre.
  */
  if (waitingFor === 'question' && questionsAnswerable) return 'El agente te hizo una pregunta: respondela en el hilo.';
  return 'La CLI esta esperando una respuesta tuya.';
}

/**
 * La barra de "el servidor de la CLI se cerro" (hito 29, M2).
 *
 * Medido con OpenCode: si su `serve` muere, el TUI enganchado no termina y la
 * pestana queda viva, `offline` y muda. La barra lo dice y ofrece relanzar,
 * que es el mismo `terminal.wake`: con la CLI viva y ese motivo, el servidor
 * termina el TUI, relanza el `serve` y vuelve a enganchar la sesion.
 *
 *  - `offer`: el motivo esta y la CLI sigue viva. Con la CLI terminada la
 *    barra de siempre ya ofrece abrirla.
 *  - `relaunching`: se pidio relanzar y todavia no termino. Gana a todo: en el
 *    medio el TUI viejo sale, y sin esto la barra de "La CLI se cerro (codigo
 *    1)" apareceria justo despues del clic.
 */
export type ServerClosedBarState = 'offer' | 'relaunching';

export function serverClosedBarState(input: {
  offlineReason: TerminalOfflineReason | null;
  alive: boolean;
  relaunching: boolean;
}): ServerClosedBarState | null {
  if (input.relaunching) return 'relaunching';
  return input.offlineReason === 'server-closed' && input.alive ? 'offer' : null;
}

/** Lo que dice la barra, y el cuadro que se apaga por ella. */
export function serverClosedBarText(label: string | null): string {
  return `El servidor de ${label ?? 'la CLI'} se cerró y esta pestaña quedó sin conexión.`;
}

export const SERVER_CLOSED_RELAUNCH_TEXT = 'Relanzar';
export const SERVER_CLOSED_RELAUNCHING_TEXT = 'Relanzando…';

/**
 * Por donde va cada relanzamiento: `waiting-exit` hasta que la lista de
 * pestanas diga que el TUI viejo termino, `exited` hasta que diga que el nuevo
 * esta vivo.
 */
export type RelaunchPhase = 'waiting-exit' | 'exited';

/**
 * Avanza los relanzamientos con una lista de pestanas nueva. `finished` son los
 * que ya no esperan nada: el TUI nuevo vive, o la pestana ya no esta. Uno que
 * todavia no vio salir al viejo no termina aunque la pestana diga "viva": esa es
 * la del TUI viejo.
 */
export function advanceRelaunches(
  phases: ReadonlyMap<TerminalId, RelaunchPhase>,
  terminals: readonly Pick<TerminalDescriptor, 'terminalId' | 'alive'>[],
): { phases: Map<TerminalId, RelaunchPhase>; finished: TerminalId[] } {
  const next = new Map<TerminalId, RelaunchPhase>();
  const finished: TerminalId[] = [];
  for (const [terminalId, phase] of phases) {
    const found = terminals.find((terminal) => terminal.terminalId === terminalId);
    if (found === undefined || (found.alive && phase === 'exited')) {
      finished.push(terminalId);
    } else {
      next.set(terminalId, found.alive ? phase : 'exited');
    }
  }
  return { phases: next, finished };
}

/**
 * Por que el cuadro no deja mandar mientras la CLI espera, o null si deja.
 *
 * Con dos clases de CLI, y con ninguna otra:
 *
 *  - La que tiene una confirmacion abierta que aprueba lo que llegue
 *    (`approvesPendingOnCycle`, R27-2): el Enter aparte del mensaje caeria
 *    sobre la opcion resaltada.
 *  - La que declara que su espera bloquea el cuadro (`waitingBlocksSubmit`,
 *    hito 29, D12): un permiso o una pregunta abiertos recibirian el pegado.
 *
 * Es el mismo texto de la barra, que ya esta a la vista; con una pregunta que
 * se contesta en el hilo, la barra lo dice (B6). Con Claude Code las dos
 * capacidades son false y el cuadro sigue como siempre.
 */
export function pendingApprovalNotice(
  capabilities: AgentCapabilities,
  waitingFor: string | null,
  alive: boolean,
): string | null {
  if (!alive || waitingFor === null) return null;
  if (capabilities.permissionCycle?.approvesPendingOnCycle !== true && !capabilities.waitingBlocksSubmit) return null;
  return waitingBarText(waitingFor, capabilities.questionCards);
}
