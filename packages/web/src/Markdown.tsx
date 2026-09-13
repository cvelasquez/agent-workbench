/**
 * Markdown, lo justo y sin dependencias.
 *
 * Por que a mano y no una libreria: el conjunto que hace falta es chico
 * —codigo, listas, titulos, negrita, enlaces, tablas— y una libreria de
 * markdown trae su propio parser de HTML, que es exactamente lo que **no**
 * queremos: `markdown-it` y compania devuelven una cadena de HTML que hay que
 * meter en `dangerouslySetInnerHTML` y sanear aparte.
 *
 * Aca no hay HTML en ningun momento. El texto se convierte directamente en
 * elementos de React, asi que nada de lo que escriba el modelo puede
 * interpretarse como marcado. La unica excepcion es el bloque de codigo, cuyo
 * contenido pasa por highlight.js —que escapa— y si no hay gramatica se
 * renderiza como texto plano.
 *
 * El resaltado de la busqueda va integrado en el renderizado en linea: si se
 * hiciera antes, partiria el markdown; si se hiciera despues, no habria donde
 * ponerlo.
 */

import { useEffect, useState } from 'react';
import { nextInlineToken } from './inline-markup.js';

/** Resalta las coincidencias de la busqueda dentro de un tramo de texto. */
function withNeedle(text: string, needle: string, keyBase: string): (JSX.Element | string)[] {
  if (needle.length === 0) return [text];

  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const nodes: (JSX.Element | string)[] = [];
  let from = 0;
  let found = lower.indexOf(target);
  let key = 0;

  while (found !== -1) {
    if (found > from) nodes.push(text.slice(from, found));
    nodes.push(<mark key={`${keyBase}-m${key++}`}>{text.slice(found, found + needle.length)}</mark>);
    from = found + needle.length;
    found = lower.indexOf(target, from);
  }
  if (from < text.length) nodes.push(text.slice(from));
  return nodes;
}

/**
 * Decide si un enlace relativo se puede abrir dentro de la app.
 *
 * Devuelve la accion, o null si ese destino no es de quien renderiza. Un
 * `[x](archivo.md)` nunca se vuelve un `<a>`: navegaria la pagina entera fuera
 * de la app. Sin resolvedor, o si el resolvedor no lo reconoce, se muestra como
 * texto, igual que siempre.
 */
export type LocalLinkResolver = (href: string) => (() => void) | null;

const LOCAL_LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

function localTarget(
  raw: string,
  resolve: LocalLinkResolver,
): { label: string; href: string; open: () => void } | null {
  const match = LOCAL_LINK.exec(raw);
  if (match === null) return null;
  const href = match[2] ?? '';
  const open = resolve(href);
  return open === null ? null : { label: match[1] ?? '', href, open };
}

/**
 * Marcado en linea: `codigo`, **negrita**, *cursiva*, ~~tachado~~ y enlaces —
 * los de markdown y las URLs sueltas.
 *
 * Que es cada token lo decide `inline-markup.ts`, que no tiene JSX y por eso
 * esta cubierto por `pnpm check`. Aca solo se dibuja.
 *
 * No cubre anidamientos raros —negrita dentro de un enlace dentro de codigo— y
 * no hace falta: lo que no matchea se muestra tal cual, que en un renderizador
 * de markdown es el unico modo de fallar aceptable.
 */
function renderInline(
  text: string,
  needle: string,
  keyBase: string,
  localLink: LocalLinkResolver | undefined,
): (JSX.Element | string)[] {
  const nodes: (JSX.Element | string)[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const match = nextInlineToken(rest);
    if (match === null) {
      nodes.push(...withNeedle(rest, needle, `${keyBase}-${key++}`));
      break;
    }

    if (match.index > 0) {
      nodes.push(...withNeedle(rest.slice(0, match.index), needle, `${keyBase}-${key++}`));
    }

    const id = `${keyBase}-i${key++}`;
    const { token } = match;

    switch (token.kind) {
      case 'code':
        nodes.push(<code key={id}>{token.text}</code>);
        break;
      case 'strong':
        nodes.push(<strong key={id}>{withNeedle(token.text, needle, id)}</strong>);
        break;
      case 'del':
        nodes.push(<del key={id}>{withNeedle(token.text, needle, id)}</del>);
        break;
      case 'em':
        nodes.push(<em key={id}>{withNeedle(token.text, needle, id)}</em>);
        break;
      case 'link':
        nodes.push(
          <a key={id} href={token.href} target="_blank" rel="noreferrer noopener">
            {withNeedle(token.label, needle, id)}
          </a>,
        );
        break;
      default: {
        const local = localLink === undefined ? null : localTarget(token.text, localLink);
        if (local !== null) {
          nodes.push(
            <button key={id} className="md-local-link" onClick={local.open} title={local.href}>
              {withNeedle(local.label, needle, id)}
            </button>,
          );
          break;
        }
        nodes.push(<span key={id}>{withNeedle(token.text, needle, id)}</span>);
        break;
      }
    }

    rest = rest.slice(match.index + match.length);
  }

  return nodes;
}

/** Bloque de codigo, con resaltado si hay gramatica para ese lenguaje. */
function CodeBlock({ code, language }: { code: string; language: string | null }): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Carga diferida: el resaltador pesa mas que el resto de la interfaz y no
    // baja hasta que aparece el primer bloque de codigo.
    void import('./highlight.js')
      .then(({ highlightCode }) => {
        if (active) setHtml(highlightCode(code, language));
      })
      .catch(() => {
        if (active) setHtml(null);
      });
    return () => {
      active = false;
    };
  }, [code, language]);

  return (
    <pre className="md-code hljs">
      {language !== null && <span className="md-code-lang">{language}</span>}
      {/* Lo que entra aca sale siempre de highlight.js, que escapa. Sin
          gramatica, el texto se renderiza como texto. */}
      {html === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
    </pre>
  );
}

interface Block {
  key: string;
  node: JSX.Element;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^\s*```(\S*)\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

/** Parte una fila de tabla en celdas, sin los pipes de los extremos. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

interface MarkdownProps {
  text: string;
  /** Termino de la busqueda, para resaltarlo. Vacio si no hay busqueda. */
  needle?: string;
  /** Enlaces relativos que se abren dentro de la app, p. ej. las notas del indice. */
  localLink?: LocalLinkResolver;
}

export function Markdown({ text, needle = '', localLink }: MarkdownProps): JSX.Element {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const key = `b${index}`;

    // --- bloque de codigo ---
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const language = (fence[1] ?? '').length > 0 ? (fence[1] as string) : null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // el cierre
      blocks.push({
        key,
        node: <CodeBlock key={key} code={body.join('\n')} language={language} />,
      });
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ key, node: <hr key={key} className="md-rule" /> });
      index += 1;
      continue;
    }

    // --- titulo ---
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = Math.min((heading[1] ?? '#').length, 6);
      blocks.push({
        key,
        node: (
          <p key={key} className={`md-heading md-h${level}`}>
            {renderInline(heading[2] ?? '', needle, key, localLink)}
          </p>
        ),
      });
      index += 1;
      continue;
    }

    // --- tabla ---
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      const header = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? '')) {
        rows.push(cells(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({
        key,
        node: (
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {header.map((cell, i) => (
                    <th key={i}>{renderInline(cell, needle, `${key}-h${i}`, localLink)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c}>{renderInline(cell, needle, `${key}-${r}-${c}`, localLink)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      });
      continue;
    }

    // --- cita ---
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        body.push(QUOTE.exec(lines[index] ?? '')?.[1] ?? '');
        index += 1;
      }
      blocks.push({
        key,
        node: (
          <blockquote key={key} className="md-quote">
            {renderInline(body.join('\n'), needle, key, localLink)}
          </blockquote>
        ),
      });
      continue;
    }

    // --- listas ---
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const bullet = BULLET.exec(current);
        const numbered = NUMBERED.exec(current);
        if (ordered && numbered !== null) items.push(numbered[2] ?? '');
        else if (!ordered && bullet !== null) items.push(bullet[1] ?? '');
        else if (
          items.length > 0 &&
          /^\s{2,}\S/.test(current) &&
          bullet === null &&
          numbered === null
        ) {
          // Continuacion indentada del item anterior.
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${current.trim()}`;
        } else break;
        index += 1;
      }

      const children = items.map((item, i) => (
        <li key={i}>{renderInline(item, needle, `${key}-l${i}`, localLink)}</li>
      ));
      blocks.push({
        key,
        node: ordered ? (
          <ol key={key} className="md-list">
            {children}
          </ol>
        ) : (
          <ul key={key} className="md-list">
            {children}
          </ul>
        ),
      });
      continue;
    }

    // --- parrafo: hasta la linea en blanco o el proximo bloque ---
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim().length === 0 ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        BULLET.test(current) ||
        NUMBERED.test(current) ||
        QUOTE.test(current) ||
        RULE.test(current) ||
        TABLE_ROW.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({
      key,
      node: (
        <p key={key} className="md-paragraph">
          {renderInline(paragraph.join('\n'), needle, key, localLink)}
        </p>
      ),
    });
  }

  return <div className="md">{blocks.map((block) => block.node)}</div>;
}
