/**
 * Los documentos abiertos de Archivos y de Planes, por pestana de proyecto
 * (Hito 40, §6.31).
 *
 * Las tiras son de `doc-tabs.ts`; aca vive lo que no es puro: el contenido de
 * cada documento, pedido al servidor cuando se muestra, y lo guardado para F5.
 *
 *  - **El contenido se pide al mostrarse**, no al abrir la app: despues de un
 *    F5 vuelven las pestanas, y cada documento se lee cuando alguien lo mira.
 *  - **Se pide con la pestana de la que vino**, que es lo que el servidor
 *    necesita para resolverlo dentro de su `cwd` (§6.3) o de su conversacion
 *    (§6.13). El cliente sigue sin nombrar una ruta absoluta.
 *  - **Lo guardado va a `sessionStorage`**: es de esta ventana, sobrevive a F5 y
 *    no a cerrarla. No va a la cookie de las preferencias (§6.26): son rutas, y
 *    viajarian en cada peticion. Tampoco sobrevive a reiniciar el servidor,
 *    porque las pestanas cambian de id; eso se acepto en el plan.
 *  - **Un error del servidor no dice que documento fallo** (`files.read` no lleva
 *    `requestId`), asi que marca como fallidos los que estaban en camino, igual
 *    que antes apagaba el "Leyendo…" del unico que habia.
 *
 * Desde el Hito 46 un archivo se edita (§6.36), y lo que se esta editando vive
 * aca y no en el visor: el visor se vuelve a montar con cada documento, y lo
 * escrito se perderia al cambiar de pestana. No va a `sessionStorage`: puede
 * ser un `.env` con claves. Se pierde con F5 (el navegador pregunta antes), al
 * cerrar la pestana del proyecto y al reiniciar el servidor; eso se acepto en
 * el plan.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffLine, FilePreview, PlanContent, ServerText, TerminalDescriptor, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import {
  closeDoc,
  docId,
  EMPTY_DOC_TABS,
  liveDocIds,
  openDoc,
  parseDocTabs,
  pruneTerminals,
  selectDoc,
  serializeDocTabs,
  setDocMode,
  showList,
  stripOf,
  withStrip,
  type DocKind,
  type DocMode,
  type DocStrip,
  type DocTabsState,
  type OpenDoc,
} from './doc-tabs.js';
import { CHANGES_GAP, editChanges, plainLineBreaks } from './edit-changes.js';

const STORAGE_KEY = 'agent-workbench.docTabs';
/** Cuanto se ve el "Guardado" de la barra despues de guardar. */
const SAVED_ACK_MS = 1_600;

export type LoadedDoc = { kind: 'file'; preview: FilePreview } | { kind: 'plan'; plan: PlanContent };

export interface DocContent {
  /** Lo ultimo que llego, o null si todavia no llego nada. */
  loaded: LoadedDoc | null;
  /** Hay un pedido en camino (el primero, o un ⟳). */
  loading: boolean;
  /** El ultimo pedido fallo. */
  failed: boolean;
}

/** Por que no se guardo: lo dijo el servidor, o se corto la conexion con el pedido en camino. */
export type DocEditFailure = { kind: 'server'; text: ServerText } | { kind: 'lost' };

/** Un archivo que se esta editando (Hito 46, §6.36). */
export interface DocEdit {
  /** Lo que se abrio para editar, con `\n`: contra esto se cuentan tus cambios. */
  opened: string;
  /** La huella del disco cuando se abrio: viaja al guardar, y si el disco ya no la tiene no se escribe. */
  baseHash: string;
  /** Lo que hay en el cuadro. */
  text: string;
  /** Hay un `files.write` en camino. */
  saving: boolean;
  failure: DocEditFailure | null;
  /**
   * El archivo cambio en el disco y lo tuyo ya no se guarda. `next` es la
   * version nueva si se puede editar; null si ya no esta o no se puede.
   */
  conflict: { next: FilePreview | null } | null;
  /** Lo que cambiaste antes de un conflicto, para pasarlo a mano a la version nueva. */
  pending: DiffLine[] | null;
  /** Se pidio cerrarlo con la ×: esperando que se confirme. */
  closing: boolean;
}

/** Lo que el visor necesita para editar un archivo. */
export interface DocEditor {
  edit: DocEdit | null;
  /** Hay algo sin guardar: lo escrito, un conflicto, o tus cambios por pasar. */
  unsaved: boolean;
  /** Se acaba de guardar: el "Guardado" breve de la barra. */
  justSaved: boolean;
  begin: () => void;
  change: (text: string) => void;
  save: () => void;
  /** Cancelar, o "Descartar mis cambios" en un conflicto. */
  discard: () => void;
  /** "Pasar mis cambios a la version nueva". */
  adopt: () => void;
  /** "Listo": esconde la lista de tus cambios. */
  dismissPending: () => void;
  /** "Descartar y cerrar", despues de la ×. */
  confirmClose: () => void;
  /** "Seguir editando", despues de la ×. */
  keepEditing: () => void;
}

export interface DocStripView {
  /** La pestana de proyecto de esta tira: la activa. */
  terminalId: TerminalId | null;
  docs: readonly OpenDoc[];
  /** El que se ve, o null si se ve la lista. */
  active: string | null;
  open: (doc: OpenDoc) => void;
  select: (key: string) => void;
  showList: () => void;
  close: (key: string) => void;
  /** La × de la tira: uno con algo sin guardar se muestra y pide confirmar, en vez de cerrarse. */
  requestClose: (key: string) => void;
  setMode: (key: string, mode: DocMode) => void;
  content: (key: string) => DocContent | undefined;
  /** Pide el contenido otra vez (o por primera vez). */
  reload: (key: string) => void;
  /** Donde quedo el scroll de un documento, para volver ahi al mostrarlo de nuevo. */
  rememberScroll: (key: string, top: number) => void;
  scrollOf: (key: string) => number | undefined;
  /** La edicion de un archivo; null en Planes o con un servidor que no guarda. */
  editorFor: (key: string) => DocEditor | null;
  /** true si ese documento tiene algo sin guardar. */
  unsaved: (key: string) => boolean;
}

export interface DocumentsView {
  files: DocStripView;
  plans: DocStripView;
}

function readSaved(): DocTabsState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw === null ? EMPTY_DOC_TABS : parseDocTabs(raw);
  } catch {
    return EMPTY_DOC_TABS;
  }
}

function isUnsaved(edit: DocEdit | undefined): boolean {
  return edit !== undefined && (edit.text !== edit.opened || edit.conflict !== null || edit.pending !== null);
}

/** Un guardado en camino: de que documento, y si ya salio por el socket o espera en la cola. */
interface PendingSave {
  id: string;
  sent: boolean;
}

export function useDocuments(
  connection: AgentConnection,
  terminals: readonly TerminalDescriptor[],
  activeTerminalId: TerminalId | null,
  /** El servidor guarda (`hello.fileWrite`): sin esto no se ofrece Editar. */
  fileWrite: boolean,
): DocumentsView {
  const [state, setState] = useState<DocTabsState>(readSaved);
  const [contents, setContents] = useState<ReadonlyMap<string, DocContent>>(new Map());
  const [edits, setEdits] = useState<ReadonlyMap<string, DocEdit>>(new Map());
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  // Espejo para la reconexion, que no puede mandar desde adentro de un `setState`.
  const contentsRef = useRef(contents);
  contentsRef.current = contents;
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const scrolls = useRef(new Map<string, number>());
  const pendingSaves = useRef(new Map<string, PendingSave>());
  const savedTimers = useRef(new Map<string, number>());

  // Lo de una pestana que se cerro se olvida.
  useEffect(() => {
    setState((current) => pruneTerminals(current, terminals.map((terminal) => terminal.terminalId)));
  }, [terminals]);

  /*
    Lo que ya no esta abierto en ninguna tira —lo cerro la ×, el tope o la
    pestana del proyecto— suelta su contenido, su altura y lo que se editaba
    (`liveDocIds`).
  */
  useEffect(() => {
    const live = liveDocIds(state);
    for (const id of [...scrolls.current.keys()]) if (!live.has(id)) scrolls.current.delete(id);
    setContents((current) => {
      const stale = [...current.keys()].filter((id) => !live.has(id));
      if (stale.length === 0) return current;
      const next = new Map(current);
      for (const id of stale) next.delete(id);
      return next;
    });
    setEdits((current) => {
      const stale = [...current.keys()].filter((id) => !live.has(id));
      if (stale.length === 0) return current;
      const next = new Map(current);
      for (const id of stale) next.delete(id);
      return next;
    });
  }, [state]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, serializeDocTabs(state));
    } catch {
      // Sin sessionStorage se pierden en un F5, nada mas.
    }
  }, [state]);

  /*
    F5 o cerrar la ventana con algo sin guardar: la pregunta del navegador. Es
    la unica ventana del navegador de la app, y solo esta mientras hay algo que
    perder.
  */
  const anyUnsaved = useMemo(() => [...edits.values()].some(isUnsaved), [edits]);
  useEffect(() => {
    if (!anyUnsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyUnsaved]);

  useEffect(() => {
    const timers = savedTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  const request = useCallback(
    (terminalId: TerminalId, kind: DocKind, key: string) => {
      const id = docId(terminalId, kind, key);
      setContents((current) =>
        new Map(current).set(id, { loaded: current.get(id)?.loaded ?? null, loading: true, failed: false }),
      );
      if (kind === 'file') connection.send({ type: 'files.read', terminalId, path: key });
      else connection.send({ type: 'plans.read', terminalId, fileName: key });
    },
    [connection],
  );

  const updateEdit = useCallback((id: string, change: (edit: DocEdit) => DocEdit | null) => {
    setEdits((current) => {
      const edit = current.get(id);
      if (edit === undefined) return current;
      const next = new Map(current);
      const changed = change(edit);
      if (changed === null) next.delete(id);
      else next.set(id, changed);
      return next;
    });
  }, []);

  const markSaved = useCallback((id: string) => {
    setSaved((current) => new Set(current).add(id));
    const previous = savedTimers.current.get(id);
    if (previous !== undefined) window.clearTimeout(previous);
    savedTimers.current.set(
      id,
      window.setTimeout(() => {
        savedTimers.current.delete(id);
        setSaved((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }, SAVED_ACK_MS),
    );
  }, []);

  useEffect(() => {
    const arrived = (id: string, loaded: LoadedDoc): void =>
      setContents((current) => (current.has(id) ? new Map(current).set(id, { loaded, loading: false, failed: false }) : current));

    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'files.preview':
          arrived(docId(message.terminalId, 'file', message.preview.path), { kind: 'file', preview: message.preview });
          break;
        case 'plans.content':
          arrived(docId(message.terminalId, 'plan', message.plan.fileName), { kind: 'plan', plan: message.plan });
          break;
        case 'files.saved': {
          const pending = pendingSaves.current.get(message.requestId);
          if (pending === undefined) break;
          pendingSaves.current.delete(message.requestId);
          const { id } = pending;
          const { preview } = message;
          if (preview !== null) arrived(id, { kind: 'file', preview });
          if (message.outcome === 'saved') {
            updateEdit(id, () => null);
            markSaved(id);
          } else {
            const next = preview !== null && preview.editable === true ? preview : null;
            updateEdit(id, (edit) => ({ ...edit, saving: false, conflict: { next } }));
          }
          break;
        }
        case 'error': {
          // Un guardado que fallo: lo escrito sigue en el cuadro, con el motivo.
          const pending = message.requestId === undefined ? undefined : pendingSaves.current.get(message.requestId);
          if (pending !== undefined && message.requestId !== undefined) {
            pendingSaves.current.delete(message.requestId);
            updateEdit(pending.id, (edit) => ({ ...edit, saving: false, failure: { kind: 'server', text: message.text } }));
            break;
          }
          setContents((current) => {
            if (![...current.values()].some((content) => content.loading)) return current;
            const next = new Map<string, DocContent>();
            for (const [id, content] of current) next.set(id, content.loading ? { ...content, loading: false, failed: true } : content);
            return next;
          });
          break;
        }
        default:
          break;
      }
    });

    // Lo que estaba en camino cuando se cayo el socket no va a llegar: se vuelve a pedir.
    const offReopen = connection.onReopen(() => {
      for (const [id, content] of contentsRef.current) {
        if (!content.loading) continue;
        const [terminalId, kind, key] = id.split('\u0000');
        if (terminalId === undefined || key === undefined) continue;
        if (kind === 'file') connection.send({ type: 'files.read', terminalId, path: key });
        if (kind === 'plan') connection.send({ type: 'plans.read', terminalId, fileName: key });
      }
      /*
        Un guardado que ya habia salido no se sabe si llego: se avisa, y lo
        escrito sigue en el cuadro. Si llego, guardar otra vez lo dice (la
        huella ya no es la del disco). El que esperaba en la cola salio recien.
      */
      for (const [requestId, pending] of pendingSaves.current) {
        if (!pending.sent) {
          pending.sent = true;
          continue;
        }
        pendingSaves.current.delete(requestId);
        updateEdit(pending.id, (edit) => ({ ...edit, saving: false, failure: { kind: 'lost' } }));
      }
    });

    return () => {
      offMessage();
      offReopen();
    };
  }, [connection, updateEdit, markSaved]);

  const stripView = useCallback(
    (kind: DocKind): DocStripView => {
      const terminalId = activeTerminalId;
      const strip: DocStrip = terminalId === null ? stripOf(EMPTY_DOC_TABS, '', kind) : stripOf(state, terminalId, kind);
      const idOf = (key: string): string | null => (terminalId === null ? null : docId(terminalId, kind, key));
      const update = (change: (strip: DocStrip) => DocStrip): void => {
        if (terminalId === null) return;
        setState((current) => withStrip(current, terminalId, kind, change(stripOf(current, terminalId, kind))));
      };
      const unsaved = (key: string): boolean => {
        const id = idOf(key);
        return id !== null && isUnsaved(edits.get(id));
      };
      // Lo que el tope de documentos no cierra.
      const keep = (): Set<string> => new Set(strip.docs.filter((doc) => unsaved(doc.key)).map((doc) => doc.key));
      const close = (key: string): void => update((current) => closeDoc(current, key));

      const editorFor = (key: string): DocEditor | null => {
        const id = idOf(key);
        if (kind !== 'file' || !fileWrite || terminalId === null || id === null) return null;
        const edit = edits.get(id) ?? null;
        return {
          edit,
          unsaved: isUnsaved(edit ?? undefined),
          justSaved: saved.has(id),
          begin: () => {
            const loaded = contents.get(id)?.loaded;
            if (loaded?.kind !== 'file' || loaded.preview.editable !== true || loaded.preview.hash === undefined) return;
            const { hash } = loaded.preview;
            const opened = plainLineBreaks(loaded.preview.text);
            setEdits((current) =>
              current.has(id)
                ? current
                : new Map(current).set(id, {
                    opened,
                    baseHash: hash,
                    text: opened,
                    saving: false,
                    failure: null,
                    conflict: null,
                    pending: null,
                    closing: false,
                  }),
            );
          },
          change: (text) => updateEdit(id, (current) => (current.conflict !== null ? current : { ...current, text, failure: null })),
          save: () => {
            const current = editsRef.current.get(id);
            if (current === undefined || current.saving || current.conflict !== null || current.text === current.opened) return;
            const requestId = crypto.randomUUID();
            const sent = connection.send({
              type: 'files.write',
              terminalId,
              requestId,
              path: key,
              text: current.text,
              baseHash: current.baseHash,
            });
            pendingSaves.current.set(requestId, { id, sent });
            updateEdit(id, (latest) => ({ ...latest, saving: true, failure: null }));
          },
          discard: () => {
            const current = editsRef.current.get(id);
            updateEdit(id, () => null);
            // Si ya no estaba en el disco, que el visor diga lo que hay ahora.
            const gone = current !== undefined && current.conflict !== null && current.conflict.next === null;
            if (gone) request(terminalId, kind, key);
          },
          adopt: () =>
            updateEdit(id, (current) => {
              const next = current.conflict?.next ?? null;
              if (next === null || next.hash === undefined) return current;
              const yours = editChanges(current.opened, current.text);
              const pending =
                yours.length === 0 ? current.pending : current.pending === null ? yours : [...current.pending, CHANGES_GAP, ...yours];
              const opened = plainLineBreaks(next.text);
              return { ...current, opened, baseHash: next.hash, text: opened, failure: null, conflict: null, pending, closing: false };
            }),
          dismissPending: () => updateEdit(id, (current) => ({ ...current, pending: null })),
          confirmClose: () => {
            updateEdit(id, () => null);
            close(key);
          },
          keepEditing: () => updateEdit(id, (current) => ({ ...current, closing: false })),
        };
      };

      return {
        terminalId,
        docs: strip.docs,
        active: strip.active,
        open: (doc) => {
          if (terminalId === null) return;
          const kept = keep();
          update((current) => openDoc(current, doc, kept));
          // Abrir uno que ya estaba lo trae al frente y lo relee: puede haber cambiado.
          request(terminalId, kind, doc.key);
        },
        select: (key) => update((current) => selectDoc(current, key)),
        showList: () => update(showList),
        close,
        requestClose: (key) => {
          const id = idOf(key);
          if (id === null || !unsaved(key)) {
            close(key);
            return;
          }
          update((current) => selectDoc(current, key));
          updateEdit(id, (current) => ({ ...current, closing: true }));
        },
        setMode: (key, mode) => update((current) => setDocMode(current, key, mode)),
        content: (key) => (terminalId === null ? undefined : contents.get(docId(terminalId, kind, key))),
        reload: (key) => {
          if (terminalId !== null) request(terminalId, kind, key);
        },
        rememberScroll: (key, top) => {
          if (terminalId !== null) scrolls.current.set(docId(terminalId, kind, key), top);
        },
        scrollOf: (key) => (terminalId === null ? undefined : scrolls.current.get(docId(terminalId, kind, key))),
        editorFor,
        unsaved,
      };
    },
    [activeTerminalId, state, contents, edits, saved, fileWrite, connection, request, updateEdit],
  );

  return useMemo(() => ({ files: stripView('file'), plans: stripView('plan') }), [stripView]);
}
