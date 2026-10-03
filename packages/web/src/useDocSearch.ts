/**
 * "Buscar en este documento", sobre lo que se ve (Hito 40, §6.31).
 *
 * Junta los trozos de texto del cuerpo ya dibujado, busca sobre la union
 * (`doc-search.ts`) y marca cada coincidencia con la API de resaltado de CSS
 * (`CSS.highlights`). No toca el DOM: meter `<mark>` dentro del HTML que arma
 * highlight.js lo romperia, y React no sabria de esos nodos.
 *
 *  - **Se vuelve a buscar cuando el cuerpo cambia**, no solo cuando cambia el
 *    texto buscado: el resaltador llega despues del primer dibujo y reemplaza
 *    los nodos, y las marcas viejas quedarian apuntando a nada. Lo avisa un
 *    `MutationObserver`.
 *  - **Sin la API** (un navegador que no la tiene) se cuenta y se salta igual a
 *    cada coincidencia; solo falta el color.
 *  - Quedan afuera los nodos de un `data-search-skip`: los numeros de linea, y
 *    el lenguaje y el boton de copiar de un bloque de codigo. Un enlace del
 *    documento si cuenta, aunque se dibuje como boton: es texto del documento.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { findMatches, locateOffset, stepIndex } from './doc-search.js';

const ALL_MATCHES = 'doc-search';
const CURRENT_MATCH = 'doc-search-current';

/** La API de resaltado de CSS, si el navegador la tiene. */
function highlightRegistry(): { set: (name: string, value: unknown) => void; delete: (name: string) => void } | null {
  const registry = (CSS as unknown as { highlights?: unknown }).highlights;
  const HighlightClass = (window as unknown as { Highlight?: unknown }).Highlight;
  if (registry === undefined || typeof HighlightClass !== 'function') return null;
  return registry as { set: (name: string, value: unknown) => void; delete: (name: string) => void };
}

function makeHighlight(ranges: Range[]): unknown {
  const HighlightClass = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  return new HighlightClass(...ranges);
}

function clearHighlights(): void {
  const registry = highlightRegistry();
  registry?.delete(ALL_MATCHES);
  registry?.delete(CURRENT_MATCH);
}

/** Trae una coincidencia a la vista, a un tercio de la altura, si no se ve. */
function revealRange(range: Range, scroller: HTMLElement | null): void {
  if (scroller === null) return;
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.top < box.top + 16 || rect.bottom > box.bottom - 16) {
    scroller.scrollTop += rect.top - box.top - box.height / 3;
  }
  if (rect.left < box.left || rect.right > box.right) {
    scroller.scrollLeft += rect.left - box.left - 48;
  }
}

export interface DocSearchState {
  count: number;
  /** La coincidencia actual, desde 0. */
  index: number;
  step: (delta: 1 | -1) => void;
}

/**
 * `contentKey` cambia cuando el cuerpo es otro —llego el contenido, otro modo—:
 * el elemento puede no existir todavia cuando se escribe la aguja.
 */
export function useDocSearch(
  bodyRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  needle: string,
  contentKey: unknown,
): DocSearchState {
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [version, setVersion] = useState(0);
  const ranges = useRef<Range[]>([]);

  // El cuerpo cambio (llego el resaltado, otro modo, otro texto): hay que volver a buscar.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null || needle.length === 0) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setVersion((current) => current + 1);
      });
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [bodyRef, needle, contentKey]);

  useEffect(() => {
    const body = bodyRef.current;
    ranges.current = [];
    if (body === null || needle.length === 0) {
      clearHighlights();
      setCount(0);
      setIndex(0);
      return;
    }

    const nodes: Text[] = [];
    const ends: number[] = [];
    let joined = '';
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('[data-search-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node as Text;
      nodes.push(text);
      joined += text.data;
      ends.push(joined.length);
    }

    ranges.current = findMatches(joined, needle).map((start) => {
      const from = locateOffset(ends, start, 'start');
      const to = locateOffset(ends, start + needle.length, 'end');
      const range = document.createRange();
      range.setStart(nodes[from.node] as Text, from.offset);
      range.setEnd(nodes[to.node] as Text, to.offset);
      return range;
    });
    setCount(ranges.current.length);
    setIndex((current) => (current < ranges.current.length ? current : 0));

    const registry = highlightRegistry();
    if (registry !== null && ranges.current.length > 0) registry.set(ALL_MATCHES, makeHighlight(ranges.current));
    else registry?.delete(ALL_MATCHES);
    return clearHighlights;
  }, [bodyRef, needle, version, contentKey]);

  // Otra aguja vuelve a la primera coincidencia.
  useEffect(() => {
    setIndex(0);
  }, [needle]);

  // La actual, con otro color, y a la vista. Tambien con otra aguja que da la
  // misma cuenta: la limpieza de la busqueda borro el color de la actual.
  useEffect(() => {
    const range = ranges.current[index];
    const registry = highlightRegistry();
    if (range === undefined) {
      registry?.delete(CURRENT_MATCH);
      return;
    }
    registry?.set(CURRENT_MATCH, makeHighlight([range]));
    revealRange(range, scrollRef.current);
  }, [index, count, version, contentKey, needle, scrollRef]);

  const step = useCallback((delta: 1 | -1) => setIndex((current) => stepIndex(current, count, delta)), [count]);

  return { count, index, step };
}
