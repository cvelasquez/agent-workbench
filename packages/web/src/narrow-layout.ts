/**
 * La vista angosta (hito 38, §6.25): lo que se decide sin React ni navegador.
 *
 * Debajo de `NARROW_MAX_WIDTH` la app deja las tres columnas y muestra una
 * sola, con una tira de vistas (`NarrowShell.tsx`). Acá está lo que la tira y
 * el cascarón necesitan decidir y `check-narrow-layout.mjs` puede probar: qué
 * vistas se ofrecen, cuál se muestra, el `?tab=` de la dirección y las teclas
 * de la fila de la terminal.
 *
 * Lo táctil es otra consulta (`TOUCH_MEDIA_QUERY`), independiente del ancho:
 * una tablet ancha tampoco tiene mouse y necesita ver los botones que en la
 * PC aparecen al pasar por encima.
 */

import type { MessageKey, MessageParams } from './i18n/index.js';
import type { PanelTab } from './SidePanel.js';

/**
 * 768 y no 640: una tablet vertical (768 a 834 px) queda mejor con una columna
 * que con tres apretadas, y en horizontal (1024 o mas) le entra el escritorio.
 */
export const NARROW_MAX_WIDTH = 768;
export const NARROW_MEDIA_QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`;
export const TOUCH_MEDIA_QUERY = '(hover: none)';

/** La vista elegida, por navegador: la PC guarda la suya en otras claves. */
export const NARROW_VIEW_STORAGE_KEY = 'agent-workbench.narrow-view';

/** Parámetro de la dirección que abre una pestaña concreta: lo que usa el aviso del teléfono. */
export const TAB_QUERY_PARAM = 'tab';

export type NarrowView = 'chat' | PanelTab | 'notes' | 'console';

/** Todas, en el orden de la tira. */
export const NARROW_VIEWS: readonly NarrowView[] = ['chat', 'cli', 'git', 'files', 'plans', 'memory', 'notes', 'console'];

export function isNarrowView(value: unknown): value is NarrowView {
  return typeof value === 'string' && (NARROW_VIEWS as readonly string[]).includes(value);
}

export function parseStoredNarrowView(raw: string): NarrowView | null {
  return isNarrowView(raw) ? raw : null;
}

export interface NarrowViewOptions {
  /** Hay una pestaña activa. Sin ella, la CLI y los paneles no tienen de qué hablar. */
  hasTab: boolean;
  /** La CLI de la pestaña tiene planes (§3.2): si no, la vista no se ofrece. */
  plansAvailable: boolean;
  /** Las vistas que el usuario escondió en Ajustes (Hito 41). El chat y la CLI no se esconden. */
  hidden?: ReadonlySet<string>;
}

/**
 * Las vistas que se ofrecen, en orden. Sin pestaña quedan el chat —que es el
 * estado vacío, con el botón de abrir una— y las notas, que no son de ninguna
 * pestaña. La consola se ofrece siempre que haya pestaña: abrir una nueva es
 * lo que ofrece la vista cuando no hay ninguna.
 */
export function narrowViews(options: NarrowViewOptions): NarrowView[] {
  const hidden = options.hidden ?? new Set<string>();
  const shown = (view: NarrowView): boolean => view === 'chat' || view === 'cli' || !hidden.has(view);
  if (!options.hasTab) return (['chat', 'notes'] as NarrowView[]).filter(shown);
  return NARROW_VIEWS.filter((view) => (view !== 'plans' || options.plansAvailable) && shown(view));
}

/** La que se muestra: la pedida si se ofrece, y si no, el chat. */
export function resolveNarrowView(wanted: NarrowView, available: readonly NarrowView[]): NarrowView {
  return available.includes(wanted) ? wanted : 'chat';
}

/** La solapa del panel de la PC que dibuja esa vista, o null para las que no son del panel. */
export function panelTabOf(view: NarrowView): PanelTab | null {
  switch (view) {
    case 'cli':
    case 'git':
    case 'files':
    case 'plans':
    case 'memory':
      return view;
    default:
      return null;
  }
}

const VIEW_LABEL_KEYS: Readonly<Record<NarrowView, MessageKey>> = {
  chat: 'narrow.view.chat',
  cli: 'panel.tab.cli',
  git: 'panel.tab.git',
  files: 'panel.tab.files',
  plans: 'panel.tab.plans',
  memory: 'panel.tab.memory',
  notes: 'notes.name',
  console: 'console.name',
};

export function narrowViewLabelKey(view: NarrowView): MessageKey {
  return VIEW_LABEL_KEYS[view];
}

// ---- `?tab=` --------------------------------------------------------------------

/** La forma de un id de pestaña: lo que arma el servidor (un uuid) y nada más largo ni con otros signos. */
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** El id de pestaña que pide la dirección, o null si no viene o no tiene forma de id. */
export function readTabParam(search: string): string | null {
  const value = new URLSearchParams(search).get(TAB_QUERY_PARAM);
  return value !== null && TAB_ID_PATTERN.test(value) ? value : null;
}

/** La query sin esos parámetros: `?a=b` o, si no queda ninguno, vacío. */
export function withoutParams(search: string, names: readonly string[]): string {
  const params = new URLSearchParams(search);
  for (const name of names) params.delete(name);
  const rest = params.toString();
  return rest.length > 0 ? `?${rest}` : '';
}

// ---- La fila de teclas -----------------------------------------------------------

export interface TerminalKey {
  id: string;
  /** Lo que se ve en el botón. Sin traducir: son nombres de teclas. */
  label: string;
  /** La secuencia que mandaría la tecla, tal como la lee la CLI. */
  data: string;
  titleKey: MessageKey;
  /** Los valores que lleva el texto de `titleKey`, si lleva. */
  titleParams?: MessageParams;
  /** La que más se aprieta (Enter): un poco más ancha y con el color de acento. */
  primary?: boolean;
}

/** Ctrl+letra: el byte de control de esa letra (`^K` es 0x0b). */
function ctrlKey(letter: string): TerminalKey {
  return {
    id: `ctrl-${letter.toLowerCase()}`,
    label: `^${letter}`,
    data: String.fromCharCode(letter.charCodeAt(0) & 0x1f),
    titleKey: 'narrow.keys.ctrl',
    titleParams: { letter },
  };
}

const ENTER: TerminalKey = { id: 'enter', label: 'Enter', data: '\r', titleKey: 'narrow.keys.enter', primary: true };
const OPTIONS: readonly TerminalKey[] = ['1', '2', '3'].map(
  (number): TerminalKey => ({
    id: `option-${number}`,
    label: number,
    data: number,
    titleKey: 'narrow.keys.number',
    titleParams: { number },
  }),
);
const ESC: TerminalKey = { id: 'esc', label: 'Esc', data: '\x1b', titleKey: 'narrow.keys.esc' };
const TAB: TerminalKey = { id: 'tab', label: 'Tab', data: '\t', titleKey: 'narrow.keys.tab' };
const SHIFT_TAB: TerminalKey = { id: 'shift-tab', label: '⇧Tab', data: '\x1b[Z', titleKey: 'narrow.keys.shiftTab' };
const UP: TerminalKey = { id: 'up', label: '↑', data: '\x1b[A', titleKey: 'narrow.keys.up' };
const DOWN: TerminalKey = { id: 'down', label: '↓', data: '\x1b[B', titleKey: 'narrow.keys.down' };
const LEFT: TerminalKey = { id: 'left', label: '←', data: '\x1b[D', titleKey: 'narrow.keys.left' };
const RIGHT: TerminalKey = { id: 'right', label: '→', data: '\x1b[C', titleKey: 'narrow.keys.right' };
const INTERRUPT: TerminalKey = { id: 'interrupt', label: '^C', data: '\x03', titleKey: 'narrow.keys.interrupt' };
const CTRL_O: TerminalKey = { id: 'ctrl-o', label: '^O', data: '\x0f', titleKey: 'narrow.keys.ctrlO' };
const CTRL_T: TerminalKey = { id: 'ctrl-t', label: '^T', data: '\x14', titleKey: 'narrow.keys.ctrlT' };
const CTRL_X: TerminalKey = { id: 'ctrl-x', label: '^X', data: '\x18', titleKey: 'narrow.keys.ctrlX' };
const HOME: TerminalKey = { id: 'home', label: 'Home', data: '\x1b[H', titleKey: 'narrow.keys.home' };
const END: TerminalKey = { id: 'end', label: 'End', data: '\x1b[F', titleKey: 'narrow.keys.end' };
const PAGE_UP: TerminalKey = { id: 'page-up', label: 'PgUp', data: '\x1b[5~', titleKey: 'narrow.keys.pageUp' };
const PAGE_DOWN: TerminalKey = { id: 'page-down', label: 'PgDn', data: '\x1b[6~', titleKey: 'narrow.keys.pageDown' };
const DELETE: TerminalKey = { id: 'delete', label: 'Del', data: '\x1b[3~', titleKey: 'narrow.keys.delete' };

/**
 * Las teclas que el teclado de un teléfono no trae, en la vista CLI. Enter va
 * primero, y los números, Esc y las flechas le siguen: son con lo que se
 * contesta un menú de la CLI (un permiso, una aprobación) que el hilo no dibuja
 * como tarjeta y vive sólo en la solapa CLI (§4.13, §10.20). Tab y Shift+Tab, y
 * las combinaciones con Ctrl que usan los agentes, al final: Ctrl+C, Ctrl+O
 * (Claude Code), Ctrl+T (la transcripción de Codex) y Ctrl+X.
 *
 * Ctrl no es un modificador de la fila: aplicarlo a la siguiente letra del
 * teclado en pantalla exigiría interceptar lo que teclea xterm. Las
 * combinaciones que se usan de verdad van como teclas propias. **Ctrl+V no
 * está**: desde el teléfono manda el byte a la PC y pega el portapapeles de la
 * PC, no el del teléfono (§5.2).
 */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
  ENTER,
  ...OPTIONS,
  ESC,
  UP,
  DOWN,
  LEFT,
  RIGHT,
  TAB,
  SHIFT_TAB,
  INTERRUPT,
  CTRL_O,
  CTRL_T,
  CTRL_X,
];

/**
 * La Consola, en dos líneas que se deslizan juntas, con todas las de la CLI y
 * las de un shell y de nano (pedido del usuario, 09-11-2026): que sobren y no
 * que falten, porque lo que no se puede apretar desde el teléfono obliga a ir a
 * la PC. Cada línea son dos pantallas de ocho: en la primera, lo de todos los
 * días; en la segunda, lo que se usa menos. Ctrl+O y Ctrl+X, que en nano
 * guardan y salen, están en la primera.
 */
export const CONSOLE_KEY_ROWS: readonly (readonly TerminalKey[])[] = [
  [ENTER, TAB, SHIFT_TAB, ESC, UP, DOWN, LEFT, RIGHT, HOME, END, PAGE_UP, PAGE_DOWN, DELETE, ...OPTIONS],
  [
    INTERRUPT,
    CTRL_O,
    CTRL_X,
    ctrlKey('K'),
    ctrlKey('U'),
    ctrlKey('W'),
    ctrlKey('R'),
    ctrlKey('L'),
    ctrlKey('D'),
    ctrlKey('Z'),
    ctrlKey('A'),
    ctrlKey('E'),
    ctrlKey('G'),
    CTRL_T,
    ctrlKey('V'),
    ctrlKey('Y'),
  ],
];

/** Qué terminal se ve debajo de la fila: la de la pestaña (la CLI) o el shell de la Consola. */
export type TerminalKeysKind = 'cli' | 'console';

/** Las líneas de teclas de esa terminal: una en la CLI, dos en la Consola. */
export function terminalKeyRows(kind: TerminalKeysKind): readonly (readonly TerminalKey[])[] {
  return kind === 'console' ? CONSOLE_KEY_ROWS : [TERMINAL_KEYS];
}

// ---- Enter en el cuadro de escritura ---------------------------------------------

/**
 * Si Enter manda el mensaje. En la PC sí, y Shift+Enter salta de línea. En una
 * pantalla táctil no: el Enter del teclado en pantalla es el único salto de
 * línea que hay, y para mandar está el botón (pedido del usuario, 25-09-2026).
 * Con un teclado físico en esa pantalla, Ctrl+Enter o Cmd+Enter mandan.
 *
 * "Táctil" es `TOUCH_MEDIA_QUERY`, no el ancho: una ventana angosta en la PC
 * sigue mandando con Enter.
 */
export function enterSubmits(
  key: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  touch: boolean,
): boolean {
  if (key.shiftKey || key.altKey) return false;
  return !touch || key.ctrlKey || key.metaKey;
}

// ---- La app del teléfono (hito 38, Fase B) ---------------------------------------

/**
 * Lo que la app de Android le suma al user agent de su visor. Con eso la hoja `⋮`
 * ofrece los ajustes de la app, que en un navegador no existen.
 */
export const PHONE_APP_UA_TOKEN = 'AgentWorkbenchAndroid/';

/** La dirección que la app intercepta para abrir sus ajustes: no es una página. */
export const PHONE_APP_SETTINGS_URL = 'agentworkbench://settings';

/**
 * La que la app intercepta para cortar el túnel. El teléfono sigue emparejado:
 * la app muestra "Desconectado" y un botón para volver a conectar.
 */
export const PHONE_APP_DISCONNECT_URL = 'agentworkbench://disconnect';

/**
 * La función global que llama la app con el botón Atrás de Android. Devuelve
 * true si cerró o cambió algo; con false, la app se va al fondo.
 */
export const NATIVE_BACK_HOOK = 'agentWorkbenchBack';

export function insidePhoneApp(userAgent: string): boolean {
  return userAgent.includes(PHONE_APP_UA_TOKEN);
}

export type NarrowBackAction = 'close-dialog' | 'close-sheet' | 'close-drawer' | 'show-chat' | null;

/**
 * Qué hace el botón Atrás del teléfono: cierra lo que esté más arriba —un
 * diálogo, una hoja, el cajón—, y sin nada encima vuelve al chat. Ya en el chat
 * no hay nada que deshacer, y la app se va al fondo con la conexión abierta.
 */
export function narrowBackAction(state: {
  dialogOpen: boolean;
  sheetOpen: boolean;
  drawerOpen: boolean;
  view: NarrowView;
}): NarrowBackAction {
  if (state.dialogOpen) return 'close-dialog';
  if (state.sheetOpen) return 'close-sheet';
  if (state.drawerOpen) return 'close-drawer';
  if (state.view !== 'chat') return 'show-chat';
  return null;
}
