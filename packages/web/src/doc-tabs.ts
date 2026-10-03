/**
 * Las pestanas de documentos de Archivos y de Planes (Hito 40, §6.31).
 *
 * Pedido del usuario: ver mas de un archivo o plan a la vez, cada uno en su
 * pestana al lado de `← Planes` / `← Archivos`, y que cambiar de pestana de
 * proyecto no los cierre. Hasta la 0.4.x el abierto vivia en `useFiles` y
 * `usePlans`, y los dos lo borraban al cambiar de pestana.
 *
 * Tres decisiones:
 *
 *  - **Cada pestana de proyecto tiene las suyas**, y dentro de ella Archivos y
 *    Planes van por separado. La columna derecha entera sigue a la pestana
 *    activa; un plan de otro proyecto debajo de la cabecera de este confundiria.
 *  - **Tope de `MAX_OPEN_DOCS` por tira.** Al abrir uno mas se cierra el que hace
 *    mas que no se mira, nunca el que se acaba de abrir.
 *  - **Lo que se guarda para F5 es la lista, no el contenido**, y se lee con
 *    desconfianza: es la pagina la que lo escribe, pero otra pagina del mismo
 *    origen tambien podria.
 *
 * Puro, sin React ni DOM: lo prueba `check-doc-viewer.mjs`.
 */

/** Cuantos documentos abiertos por tira. Pasado, se cierra el que hace mas que no se mira. */
export const MAX_OPEN_DOCS = 8;

/** Una ruta o una ref mas larga que esto no es de verdad. */
const MAX_KEY_LENGTH = 1_024;
const MAX_TITLE_LENGTH = 300;

export type DocKind = 'file' | 'plan';
export const DOC_KINDS: readonly DocKind[] = ['file', 'plan'];

/** Como se ve un Markdown: formateado, o el fuente. */
export type DocMode = 'formatted' | 'source';

export interface OpenDoc {
  /** La ruta relativa de un archivo, o la ref opaca de un plan. Nunca una ruta absoluta. */
  key: string;
  /** Lo que dice la pestana. */
  title: string;
  /** Solo en un Markdown que se cambio de modo; sin el, formateado. */
  mode?: DocMode;
}

export interface DocStrip {
  /** En el orden en que se ven. */
  docs: OpenDoc[];
  /** La que se muestra, o null si se ve la lista. */
  active: string | null;
  /** Las claves de `docs`, de la que hace mas que no se mira a la ultima. */
  recent: string[];
}

export const EMPTY_STRIP: DocStrip = { docs: [], active: null, recent: [] };

/** Las tiras de cada pestana de proyecto. Un objeto y no un Map: va tal cual a JSON. */
export type DocTabsState = Readonly<Record<string, Readonly<Record<DocKind, DocStrip>>>>;

export const EMPTY_DOC_TABS: DocTabsState = {};

function touch(recent: readonly string[], key: string): string[] {
  return [...recent.filter((item) => item !== key), key];
}

/** Abre un documento, o lo trae al frente si ya estaba. */
export function openDoc(strip: DocStrip, doc: OpenDoc): DocStrip {
  const known = strip.docs.find((item) => item.key === doc.key);
  if (known !== undefined) {
    // El titulo puede haber cambiado (un plan reescrito): se actualiza.
    const docs = known.title === doc.title ? strip.docs : strip.docs.map((item) => (item.key === doc.key ? { ...item, title: doc.title } : item));
    return { docs, active: doc.key, recent: touch(strip.recent, doc.key) };
  }
  let docs = [...strip.docs, { key: doc.key, title: doc.title }];
  let recent = touch(strip.recent, doc.key);
  while (docs.length > MAX_OPEN_DOCS) {
    const oldest = recent.find((key) => key !== doc.key);
    if (oldest === undefined) break;
    docs = docs.filter((item) => item.key !== oldest);
    recent = recent.filter((key) => key !== oldest);
  }
  return { docs, active: doc.key, recent };
}

/** Muestra un documento ya abierto. Uno que no esta no cambia nada. */
export function selectDoc(strip: DocStrip, key: string): DocStrip {
  if (!strip.docs.some((item) => item.key === key)) return strip;
  return { ...strip, active: key, recent: touch(strip.recent, key) };
}

/** Vuelve a la lista sin cerrar nada. */
export function showList(strip: DocStrip): DocStrip {
  return strip.active === null ? strip : { ...strip, active: null };
}

/**
 * Cierra un documento. Si era el que se veia, se muestra el que queda en su
 * lugar —el de la derecha—, o el de la izquierda si era el ultimo, o la lista.
 */
export function closeDoc(strip: DocStrip, key: string): DocStrip {
  const index = strip.docs.findIndex((item) => item.key === key);
  if (index === -1) return strip;
  const docs = strip.docs.filter((item) => item.key !== key);
  const recent = strip.recent.filter((item) => item !== key);
  if (strip.active !== key) return { docs, active: strip.active, recent };
  const next = docs[index] ?? docs[index - 1] ?? null;
  return { docs, active: next === null ? null : next.key, recent: next === null ? recent : touch(recent, next.key) };
}

/** Formateado o fuente, para un Markdown abierto. */
export function setDocMode(strip: DocStrip, key: string, mode: DocMode): DocStrip {
  return { ...strip, docs: strip.docs.map((item) => (item.key === key ? { ...item, mode } : item)) };
}

export function stripOf(state: DocTabsState, terminalId: string, kind: DocKind): DocStrip {
  return state[terminalId]?.[kind] ?? EMPTY_STRIP;
}

export function withStrip(state: DocTabsState, terminalId: string, kind: DocKind, strip: DocStrip): DocTabsState {
  const current = state[terminalId] ?? { file: EMPTY_STRIP, plan: EMPTY_STRIP };
  return { ...state, [terminalId]: { ...current, [kind]: strip } };
}

/**
 * Olvida lo de las pestanas que ya no estan. Con la lista vacia no olvida nada:
 * puede ser que todavia no llego la del servidor, y lo guardado para F5 se
 * perderia antes de poder usarlo.
 */
export function pruneTerminals(state: DocTabsState, liveTerminalIds: readonly string[]): DocTabsState {
  if (liveTerminalIds.length === 0) return state;
  const live = new Set(liveTerminalIds);
  const stale = Object.keys(state).filter((terminalId) => !live.has(terminalId));
  if (stale.length === 0) return state;
  const next: Record<string, Readonly<Record<DocKind, DocStrip>>> = { ...state };
  for (const terminalId of stale) delete next[terminalId];
  return next;
}

/** La identidad de un documento abierto: de que pestana, de que solapa y cual. */
export function docId(terminalId: string, kind: DocKind, key: string): string {
  return `${terminalId}\u0000${kind}\u0000${key}`;
}

/**
 * Los documentos que siguen abiertos en alguna tira. Lo que no esta aca —lo
 * cerro la ×, el tope o la pestana del proyecto— suelta su contenido y su
 * altura (`useDocuments`): sin esto, lo que cerraba el tope quedaba en memoria
 * hasta cerrar la pestana del proyecto (lo encontro la revision de la 0.5.0).
 */
export function liveDocIds(state: DocTabsState): Set<string> {
  const ids = new Set<string>();
  for (const [terminalId, strips] of Object.entries(state)) {
    for (const kind of DOC_KINDS) {
      for (const doc of strips[kind].docs) ids.add(docId(terminalId, kind, doc.key));
    }
  }
  return ids;
}

export function serializeDocTabs(state: DocTabsState): string {
  return JSON.stringify(state);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseOpenDoc(value: unknown): OpenDoc | null {
  const record = asRecord(value);
  if (record === null) return null;
  const { key, title, mode } = record;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
  if (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH) return null;
  const doc: OpenDoc = { key, title };
  return mode === 'formatted' || mode === 'source' ? { ...doc, mode } : doc;
}

function parseStrip(value: unknown): DocStrip {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record['docs'])) return EMPTY_STRIP;
  const docs: OpenDoc[] = [];
  for (const item of record['docs']) {
    const doc = parseOpenDoc(item);
    if (doc !== null && !docs.some((known) => known.key === doc.key)) docs.push(doc);
    if (docs.length === MAX_OPEN_DOCS) break;
  }
  const keys = docs.map((doc) => doc.key);
  const active = typeof record['active'] === 'string' && keys.includes(record['active']) ? record['active'] : null;
  const savedRecent = Array.isArray(record['recent'])
    ? record['recent'].filter((key): key is string => typeof key === 'string' && keys.includes(key))
    : [];
  const recent = [...keys.filter((key) => !savedRecent.includes(key)), ...new Set(savedRecent)];
  return { docs, active, recent };
}

/** Lo guardado para F5. Lo que no tiene forma se descarta sin llevarse lo demas. */
export function parseDocTabs(raw: string): DocTabsState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_DOC_TABS;
  }
  const record = asRecord(value);
  if (record === null) return EMPTY_DOC_TABS;
  const state: Record<string, Readonly<Record<DocKind, DocStrip>>> = {};
  for (const [terminalId, entry] of Object.entries(record)) {
    const strips = asRecord(entry);
    if (strips === null || terminalId.length === 0 || terminalId.length > MAX_KEY_LENGTH) continue;
    const file = parseStrip(strips['file']);
    const plan = parseStrip(strips['plan']);
    if (file.docs.length === 0 && plan.docs.length === 0) continue;
    state[terminalId] = { file, plan };
  }
  return state;
}
