/**
 * Los archivos del proyecto que el hilo puede abrir (§6.33), y desde el
 * 23-10-2026 las carpetas, que se abren en el explorador del sistema.
 *
 * `project-paths.ts` saca los candidatos de lo que escribio el agente; aca se
 * le pregunta al servidor cuales existen (`files.check`) y se le da al hilo con
 * que volver enlace cada mencion. Lo que no es puro:
 *
 *  - **Se pregunta por tandas**, de a lo sumo `FILES_CHECK_MAX_PATHS`, y solo lo
 *    de los mensajes que todavia no se miraron. Una conversacion larga no
 *    vuelve a preguntar todo con cada mensaje nuevo.
 *  - **Lo que no estaba se vuelve a preguntar cuando el agente lo nombra otra
 *    vez**: "voy a escribir `docs/plan.md`" todavia no es un enlace, y el
 *    "listo, quedo en `docs/plan.md`" de despues vuelve enlace a los dos.
 *  - **Lo de cada pestana va aparte**: la misma ruta relativa es otro archivo en
 *    otro proyecto. Al cerrar la pestana se olvida.
 *  - **Con el socket caido no se pierde nada**: lo que estaba en camino se
 *    vuelve a mirar al reconectar.
 *
 * Apagado —un servidor anterior, o la solapa Archivos escondida en Ajustes—
 * devuelve null y el hilo queda como antes: texto.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { FILES_CHECK_MAX_PATHS, type ConversationEvent, type TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import type { CodeLink, CodeLinkResolver, LocalLinkResolver } from './Markdown.js';
import {
  pathCandidates,
  pathsToCheck,
  projectLinkPathOf,
  projectPathOf,
  withChecked,
  type PathKind,
  type ProjectRoot,
} from './project-paths.js';

/** Cuantas rutas se preguntan, como mucho, por cada vez que cambia el hilo. */
const MAX_PATHS_PER_PASS = 1_000;

export interface FileLinks {
  /** La accion de una mencion entre acentos graves, o null si no es un archivo ni una carpeta del proyecto. */
  code: CodeLinkResolver;
  /** Lo mismo para el destino de un enlace de Markdown. */
  link: LocalLinkResolver;
}

interface TabPaths {
  known: Map<string, PathKind | null>;
  /** Lo que se pregunto y todavia no volvio. */
  pending: Set<string>;
  /** Los mensajes cuyas menciones ya se miraron. */
  scanned: WeakSet<ConversationEvent>;
}

export function useFileLinks(options: {
  connection: AgentConnection;
  enabled: boolean;
  terminalId: TerminalId | null;
  cwd: string;
  platform: string;
  events: readonly ConversationEvent[];
  /** Las pestanas que existen: lo de una que se cerro se olvida. */
  liveTerminalIds: readonly TerminalId[];
  onOpen: (relativePath: string) => void;
  /**
   * Abre una carpeta en el explorador del sistema (23-10-2026). null en una
   * ventana que entro como equipo remoto: se abriria en el escritorio del
   * anfitrion, y la carpeta queda como texto.
   */
  onOpenFolder: ((relativePath: string) => void) | null;
}): FileLinks | null {
  const { connection, enabled, terminalId, cwd, platform, events, liveTerminalIds, onOpen, onOpenFolder } = options;
  const tabs = useRef(new Map<TerminalId, TabPaths>());
  const requests = useRef(new Map<string, { terminalId: TerminalId; paths: string[] }>());
  const nextRequest = useRef(0);
  // Lo que se sabe cambio: el hilo vuelve a preguntar que es enlace.
  const [version, setVersion] = useState(0);
  // El socket volvio: lo que estaba en camino se mira otra vez.
  const [reconnects, setReconnects] = useState(0);

  const root = useMemo<ProjectRoot>(() => ({ cwd, platform }), [cwd, platform]);

  useEffect(() => {
    const offMessage = connection.onMessage((message) => {
      if (message.type !== 'files.checked') return;
      const request = requests.current.get(message.requestId);
      if (request === undefined) return;
      requests.current.delete(message.requestId);
      const tab = tabs.current.get(request.terminalId);
      if (tab === undefined) return;
      for (const path of request.paths) tab.pending.delete(path);
      tab.known = withChecked(tab.known, request.paths, message.existing, message.directories);
      setVersion((current) => current + 1);
    });
    const offReopen = connection.onReopen(() => {
      // Las respuestas de lo que salio por el socket caido no llegan nunca.
      requests.current.clear();
      for (const tab of tabs.current.values()) {
        tab.pending.clear();
        tab.scanned = new WeakSet();
      }
      setReconnects((current) => current + 1);
    });
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  useEffect(() => {
    const live = new Set(liveTerminalIds);
    for (const id of [...tabs.current.keys()]) if (!live.has(id)) tabs.current.delete(id);
  }, [liveTerminalIds]);

  useEffect(() => {
    if (!enabled || terminalId === null || cwd.length === 0) return;
    let tab = tabs.current.get(terminalId);
    if (tab === undefined) {
      tab = { known: new Map(), pending: new Set(), scanned: new WeakSet() };
      tabs.current.set(terminalId, tab);
    }

    const fresh = new Set<string>();
    for (const event of events) {
      if (tab.scanned.has(event)) continue;
      tab.scanned.add(event);
      // Lo del usuario se muestra tal cual, sin marcado (§6.27): ahi no hay enlaces.
      if (event.role !== 'assistant') continue;
      for (const part of event.parts) {
        if (part.kind !== 'text') continue;
        for (const path of pathCandidates(part.text, root)) fresh.add(path);
      }
    }

    const asking = pathsToCheck([...fresh], tab.known, tab.pending).slice(0, MAX_PATHS_PER_PASS);
    for (let from = 0; from < asking.length; from += FILES_CHECK_MAX_PATHS) {
      const paths = asking.slice(from, from + FILES_CHECK_MAX_PATHS);
      nextRequest.current += 1;
      const requestId = `files-${nextRequest.current}`;
      requests.current.set(requestId, { terminalId, paths });
      for (const path of paths) tab.pending.add(path);
      connection.send({ type: 'files.check', terminalId, requestId, paths });
    }
  }, [connection, enabled, terminalId, cwd, root, events, reconnects]);

  return useMemo(() => {
    if (!enabled || terminalId === null) return null;
    const known = tabs.current.get(terminalId)?.known;
    // Un archivo se abre en Archivos; una carpeta, en el explorador del sistema.
    const linkOf = (path: string | null): CodeLink | null => {
      if (path === null) return null;
      const kind = known?.get(path) ?? null;
      if (kind === 'file') return { open: () => onOpen(path), folder: false };
      if (kind === 'directory' && onOpenFolder !== null) return { open: () => onOpenFolder(path), folder: true };
      return null;
    };
    return {
      code: (mention) => linkOf(projectPathOf(mention, root)),
      link: (href) => linkOf(projectLinkPathOf(href, root))?.open ?? null,
    };
    // `version`: lo que cambia es el mapa de adentro, no su referencia.
  }, [enabled, terminalId, root, onOpen, onOpenFolder, version]);
}
