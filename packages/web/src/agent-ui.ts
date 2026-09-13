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
  type AgentCapabilities,
  type AgentId,
  type AgentInfo,
  type ContextWindowSource,
  type EffortOption,
  type ModelOption,
  type PermissionCycleCapability,
  type PermissionMode,
  type TerminalActivity,
} from '@agent-workbench/shared';

export interface Shortcut {
  keys: string;
  description: string;
}

/** Lo que la pantalla sabe de una CLI y no le pregunta al servidor. */
export interface AgentUi {
  /** Las teclas de la CLI dentro de su terminal, para el dialogo de atajos. */
  shortcuts: readonly Shortcut[];
  /** El archivo de instrucciones del proyecto que la CLI carga al arrancar. */
  instructionsFile: string;
}

/**
 * Una entrada por CLI con adaptador.
 *
 * Es un `Record` exhaustivo a proposito: agregar un id a `AGENT_IDS` sin su
 * entrada aca no compila, y asi el dialogo de atajos no queda mudo para la CLI
 * nueva sin que nadie lo note.
 */
export const AGENT_UI: Record<AgentId, AgentUi> = {
  'claude-code': {
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
    instructionsFile: 'CLAUDE.md',
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
