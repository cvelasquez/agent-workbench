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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilePreview, PlanContent, TerminalDescriptor, TerminalId } from '@agent-workbench/shared';
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

const STORAGE_KEY = 'agent-workbench.docTabs';

export type LoadedDoc = { kind: 'file'; preview: FilePreview } | { kind: 'plan'; plan: PlanContent };

export interface DocContent {
  /** Lo ultimo que llego, o null si todavia no llego nada. */
  loaded: LoadedDoc | null;
  /** Hay un pedido en camino (el primero, o un ⟳). */
  loading: boolean;
  /** El ultimo pedido fallo. */
  failed: boolean;
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
  setMode: (key: string, mode: DocMode) => void;
  content: (key: string) => DocContent | undefined;
  /** Pide el contenido otra vez (o por primera vez). */
  reload: (key: string) => void;
  /** Donde quedo el scroll de un documento, para volver ahi al mostrarlo de nuevo. */
  rememberScroll: (key: string, top: number) => void;
  scrollOf: (key: string) => number | undefined;
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

export function useDocuments(
  connection: AgentConnection,
  terminals: readonly TerminalDescriptor[],
  activeTerminalId: TerminalId | null,
): DocumentsView {
  const [state, setState] = useState<DocTabsState>(readSaved);
  const [contents, setContents] = useState<ReadonlyMap<string, DocContent>>(new Map());
  // Espejo para la reconexion, que no puede mandar desde adentro de un `setState`.
  const contentsRef = useRef(contents);
  contentsRef.current = contents;
  const scrolls = useRef(new Map<string, number>());

  // Lo de una pestana que se cerro se olvida.
  useEffect(() => {
    setState((current) => pruneTerminals(current, terminals.map((terminal) => terminal.terminalId)));
  }, [terminals]);

  /*
    Lo que ya no esta abierto en ninguna tira —lo cerro la ×, el tope o la
    pestana del proyecto— suelta su contenido y su altura (`liveDocIds`).
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
  }, [state]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, serializeDocTabs(state));
    } catch {
      // Sin sessionStorage se pierden en un F5, nada mas.
    }
  }, [state]);

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
        case 'error':
          setContents((current) => {
            if (![...current.values()].some((content) => content.loading)) return current;
            const next = new Map<string, DocContent>();
            for (const [id, content] of current) next.set(id, content.loading ? { ...content, loading: false, failed: true } : content);
            return next;
          });
          break;
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
    });

    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  const stripView = useCallback(
    (kind: DocKind): DocStripView => {
      const terminalId = activeTerminalId;
      const strip: DocStrip = terminalId === null ? stripOf(EMPTY_DOC_TABS, '', kind) : stripOf(state, terminalId, kind);
      const update = (change: (strip: DocStrip) => DocStrip): void => {
        if (terminalId === null) return;
        setState((current) => withStrip(current, terminalId, kind, change(stripOf(current, terminalId, kind))));
      };
      return {
        terminalId,
        docs: strip.docs,
        active: strip.active,
        open: (doc) => {
          if (terminalId === null) return;
          update((current) => openDoc(current, doc));
          // Abrir uno que ya estaba lo trae al frente y lo relee: puede haber cambiado.
          request(terminalId, kind, doc.key);
        },
        select: (key) => update((current) => selectDoc(current, key)),
        showList: () => update(showList),
        close: (key) => update((current) => closeDoc(current, key)),
        setMode: (key, mode) => update((current) => setDocMode(current, key, mode)),
        content: (key) => (terminalId === null ? undefined : contents.get(docId(terminalId, kind, key))),
        reload: (key) => {
          if (terminalId !== null) request(terminalId, kind, key);
        },
        rememberScroll: (key, top) => {
          if (terminalId !== null) scrolls.current.set(docId(terminalId, kind, key), top);
        },
        scrollOf: (key) => (terminalId === null ? undefined : scrolls.current.get(docId(terminalId, kind, key))),
      };
    },
    [activeTerminalId, state, contents, request],
  );

  return useMemo(() => ({ files: stripView('file'), plans: stripView('plan') }), [stripView]);
}
