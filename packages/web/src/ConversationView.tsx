/**
 * La conversacion. Desde el hito 7 es la vista principal, en el centro.
 *
 * Sigue en vivo el JSONL de la pestana activa. Es de solo lectura: lo que se
 * escribe sale por el cuadro de abajo, que le habla a la pty. El archivo es la
 * unica fuente de lo que se ve — si el usuario tecleo directamente en la
 * pestana CLI, aparece igual y por el mismo camino.
 *
 * Decisiones de forma, casi todas del hito 9:
 *
 *  - **Lo del usuario se resalta; lo del asistente no lleva tarjeta.** El
 *    asistente escribe diez veces mas; enmarcar cada respuesta convierte la
 *    lectura en un catalogo de cajas. Lo que hay que encontrar de un vistazo es
 *    *que pedi yo*, y eso son cuatro lineas cada tanto.
 *  - **Un mensaje propio de mas de cuatro lineas se pliega.** Igual que en el
 *    cuadro de escritura y por lo mismo: el pedido importa entero, pero
 *    releerlo completo casi nunca.
 *  - **El razonamiento no aparece.** El archivo guarda la firma y no el texto:
 *    medidos 635 bloques en las 15 sesiones mas recientes, 0 con contenido.
 *    Hasta el hito 11 se marcaba con un "razono antes de responder", que es
 *    justamente lo que el usuario no necesita: quien quiere leer el
 *    razonamiento —para cortar a tiempo un analisis que va por mal camino— lo
 *    tiene en vivo en la pestana CLI, y una etiqueta que solo dice que existio
 *    ocupa lugar sin decir nada. Se descarta al armar las tarjetas.
 *  - **Los resultados de herramienta van dentro de su llamada.** En el archivo
 *    viven en un mensaje de usuario aparte; renderizados tal cual, cada Bash
 *    generaria una tarjeta "de usuario" con un volcado de stdout.
 *  - **Las imagenes se piden al aparecer.** El evento trae la referencia; los
 *    bytes se buscan en el archivo solo cuando hay que dibujarlos.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AnswerSelection,
  ConversationEvent,
  ConversationImageSource,
  ConversationPart,
  ConversationQuestionPart,
  ConversationToolResultPart,
} from '@agent-workbench/shared';
import { ContextMeter } from './ContextMeter.js';
import { ImageViewer } from './ImageViewer.js';
import { Markdown } from './Markdown.js';
import { imageKey, type ConversationFeed } from './useConversation.js';

/** Margen para decidir si el usuario estaba mirando el final. */
const STICK_TO_BOTTOM_PX = 80;

/** A partir de cuantas lineas se pliega un mensaje propio. */
const FOLD_FROM_LINES = 5;

interface Card {
  event: ConversationEvent;
  /** Partes ya sin los resultados que se dibujan dentro de su llamada. */
  parts: ConversationPart[];
}

/**
 * Como se llama un grupo de herramientas del mismo tipo.
 *
 * La CLI resume su propia tanda de acciones en una linea —"Ran 5 shell
 * commands"— y esta es la misma idea: quince tarjetas colapsadas seguidas,
 * cada una con su hora y su etiqueta de esfuerzo al pie, ocupan media pantalla
 * para decir "corri comandos". Lo que se lee de un vistazo es *que* hizo, no
 * cuantas veces llamo a Bash.
 *
 * La lista es corta y explicita a proposito. Un nombre que no este —una
 * herramienta nueva, un MCP— no se fuerza a ninguna categoria: se agrupa con
 * las de su mismo nombre y se muestra tal cual. Inventarle una categoria a lo
 * que no conocemos es como se termina resumiendo mal.
 */
const TOOL_CATEGORIES: readonly { key: string; names: readonly string[]; label: string }[] = [
  { key: 'shell', names: ['Bash', 'PowerShell', 'BashOutput', 'KillShell'], label: 'comandos de consola' },
  { key: 'read', names: ['Read', 'NotebookRead'], label: 'archivos leidos' },
  { key: 'find', names: ['Glob', 'Grep', 'LS'], label: 'busquedas en el proyecto' },
  { key: 'edit', names: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'], label: 'ediciones' },
  { key: 'web', names: ['WebSearch', 'WebFetch', 'ToolSearch'], label: 'busquedas' },
  { key: 'agent', names: ['Task', 'Agent'], label: 'subagentes' },
  { key: 'todo', names: ['TodoWrite'], label: 'listas de tareas' },
];

function toolCategory(name: string): { key: string; label: string | null } {
  const found = TOOL_CATEGORIES.find((entry) => entry.names.includes(name));
  // Sin categoria conocida, la clave es el nombre: dos llamadas seguidas a la
  // misma herramienta siguen siendo una tanda, y el resumen las nombra.
  return found === undefined ? { key: `name:${name}`, label: null } : found;
}

/** true si lo elegido en una pregunta es texto escrito y no opciones. */
function isFree(
  selection: AnswerSelection,
): selection is Extract<AnswerSelection, { kind: 'free' }> {
  return !Array.isArray(selection);
}

/** Los nombres de las herramientas de una tarjeta, si es **solo** eso. */
function toolNamesOf(card: Card): string[] | null {
  const names: string[] = [];
  for (const part of card.parts) {
    if (part.kind !== 'tool-call') return null;
    names.push(part.name);
  }
  return names.length > 0 ? names : null;
}

/**
 * Una fila de la conversacion: una tarjeta suelta, o una tanda de acciones.
 *
 * La tanda existe solo si hay **dos o mas** llamadas seguidas de la misma
 * clase. Con una sola, resumir esconderia el nombre de la herramienta sin
 * ahorrar nada.
 */
type Block =
  | { kind: 'card'; card: Card }
  | { kind: 'tools'; id: string; summary: string; at: number; cards: Card[] };

function groupCards(cards: readonly Card[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < cards.length) {
    const card = cards[index];
    if (card === undefined) break;

    const names = toolNamesOf(card);
    const category = names === null ? null : toolCategory(names[0] ?? '');

    // Una tarjeta con herramientas de dos clases distintas no se agrupa: el
    // resumen tendria que mentir sobre una de las dos.
    const uniform =
      names !== null &&
      category !== null &&
      names.every((name) => toolCategory(name).key === category.key);

    if (!uniform || names === null || category === null) {
      blocks.push({ kind: 'card', card });
      index += 1;
      continue;
    }

    const run: Card[] = [card];
    let count = names.length;
    let at = index + 1;
    while (at < cards.length) {
      const next = cards[at];
      if (next === undefined) break;
      const nextNames = toolNamesOf(next);
      if (nextNames === null) break;
      if (!nextNames.every((name) => toolCategory(name).key === category.key)) break;
      run.push(next);
      count += nextNames.length;
      at += 1;
    }

    if (count < 2) {
      blocks.push({ kind: 'card', card });
      index += 1;
      continue;
    }

    const label = category.label ?? `llamadas a ${names[0] ?? ''}`;
    blocks.push({
      kind: 'tools',
      id: `tools-${card.event.eventId}`,
      summary: `${count} ${label}`,
      at: card.event.at,
      cards: run,
    });
    index = at;
  }

  return blocks;
}

function partText(part: ConversationPart): string {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'tool-call':
      return `${part.name} ${part.input}`;
    case 'tool-result':
      return part.text;
    case 'question':
      return part.questions
        .map((item) => `${item.question} ${item.options.map((o) => o.label).join(' ')}`)
        .join('\n');
    case 'thinking':
    case 'image':
      return '';
  }
}

function cardText(card: Card, results: Map<string, ConversationToolResultPart>): string {
  const pieces: string[] = [];
  for (const part of card.parts) {
    pieces.push(partText(part));
    if (part.kind === 'tool-call') {
      const result = results.get(part.toolUseId);
      if (result !== undefined) pieces.push(result.text);
    }
  }
  return pieces.join('\n');
}

function formatTime(at: number): string {
  if (at <= 0) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Duracion de un turno, en la unidad que se lee de un vistazo.
 *
 * Sale de la propia CLI (`system/turn_duration`), no de restar marcas de
 * tiempo: esa resta incluye lo que el usuario tardo en escribir lo siguiente.
 */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** Resalta las coincidencias en texto plano (lo que no pasa por Markdown). */
function highlight(text: string, needle: string): JSX.Element {
  if (needle.length === 0) return <>{text}</>;

  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const nodes: JSX.Element[] = [];
  let from = 0;
  let found = lower.indexOf(target);
  let key = 0;

  while (found !== -1) {
    if (found > from) nodes.push(<span key={key++}>{text.slice(from, found)}</span>);
    nodes.push(<mark key={key++}>{text.slice(found, found + needle.length)}</mark>);
    from = found + needle.length;
    found = lower.indexOf(target, from);
  }
  if (from < text.length) nodes.push(<span key={key++}>{text.slice(from)}</span>);

  return <>{nodes}</>;
}

interface ConversationViewProps {
  view: ConversationFeed;
  /** Manda `Esc Esc` a la pty para abrir el menu de rewind de la CLI. */
  onRewind: () => void;
  /** Abre la solapa CLI: es donde se contesta lo que la CLI este esperando. */
  onGoToCli: () => void;
}

export function ConversationView({
  view,
  onRewind,
  onGoToCli,
}: ConversationViewProps): JSX.Element {
  const {
    events,
    usage,
    defaults,
    state,
    waitingFor,
    hasMore,
    loadingMore,
    loadMore,
    images,
    requestImage,
    answer,
    answered,
    answerFailed,
  } = view;

  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const stickToBottom = useRef(true);

  const { cards, results } = useMemo(() => {
    const resultsByTool = new Map<string, ConversationToolResultPart>();
    const callIds = new Set<string>();

    for (const event of events) {
      for (const part of event.parts) {
        if (part.kind === 'tool-result') resultsByTool.set(part.toolUseId, part);
        // Una pregunta cuenta como llamada: su resultado se absorbe igual, y
        // ademas es el que dice que ya no espera respuesta.
        else if (part.kind === 'tool-call' || part.kind === 'question') {
          callIds.add(part.toolUseId);
        }
      }
    }

    const built: Card[] = [];
    for (const event of events) {
      // Un resultado cuya llamada no esta cargada si se muestra: es preferible
      // una tarjeta suelta a que el dato desaparezca sin decir nada.
      //
      // El razonamiento se descarta aca y no al dibujar, para que un turno que
      // era solo razonamiento no deje una tarjeta vacia con su reloj al pie.
      const parts = event.parts.filter(
        (part) =>
          part.kind !== 'thinking' &&
          !(part.kind === 'tool-result' && callIds.has(part.toolUseId)),
      );
      if (parts.length === 0) continue;
      built.push({ event, parts });
    }

    return { cards: built, results: resultsByTool };
  }, [events]);

  /*
    Las tandas de acciones se agrupan aca y no al dibujar: una tanda es una
    fila de la lista, no un adorno de las tarjetas que la componen.
  */
  const blocks = useMemo(() => groupCards(cards), [cards]);

  const needle = query.trim();
  const matches = useMemo(() => {
    if (needle.length === 0) return [];
    const lower = needle.toLowerCase();
    return cards
      .filter((card) => cardText(card, results).toLowerCase().includes(lower))
      .map((card) => card.event.eventId);
  }, [cards, results, needle]);

  useEffect(() => {
    setMatchIndex(0);
  }, [needle]);

  const matched = useMemo(() => new Set(matches), [matches]);
  const activeMatchId = matches[matchIndex] ?? null;
  useEffect(() => {
    if (activeMatchId === null) return;
    cardRefs.current.get(activeMatchId)?.scrollIntoView({ block: 'center' });
  }, [activeMatchId]);

  /**
   * Pegado al final solo si el usuario ya estaba ahi.
   *
   * Arrastrarlo hacia abajo mientras lee algo de hace diez mensajes es la forma
   * mas rapida de volver inutil una vista que se actualiza sola.
   */
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container === null || !stickToBottom.current || needle.length > 0) return;
    container.scrollTop = container.scrollHeight;
  }, [cards.length, needle]);

  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (container === null) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    stickToBottom.current = distance <= STICK_TO_BOTTOM_PX;
  }, []);

  const registerCard = useCallback((eventId: string, element: HTMLElement | null) => {
    if (element === null) cardRefs.current.delete(eventId);
    else cardRefs.current.set(eventId, element);
  }, []);

  const copyCard = useCallback(
    (card: Card) => {
      const text = cardText(card, results);
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedId(card.event.eventId);
          window.setTimeout(() => setCopiedId(null), 1_200);
        })
        .catch(() => setCopiedId(null));
    },
    [results],
  );

  const stepMatch = (offset: number): void => {
    if (matches.length === 0) return;
    setMatchIndex((current) => (current + offset + matches.length) % matches.length);
  };

  return (
    <div className="conversation-pane">
      <div className="conversation-search">
        <input
          className="conversation-search-input"
          type="search"
          placeholder="Buscar en la conversacion"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') stepMatch(event.shiftKey ? -1 : 1);
            event.stopPropagation();
          }}
          spellCheck={false}
        />
        {needle.length > 0 && (
          <>
            <span className="conversation-matches">
              {matches.length === 0 ? 'sin resultados' : `${matchIndex + 1}/${matches.length}`}
            </span>
            <button
              className="icon-button"
              onClick={() => stepMatch(-1)}
              disabled={matches.length === 0}
              title="Anterior"
            >
              ↑
            </button>
            <button
              className="icon-button"
              onClick={() => stepMatch(1)}
              disabled={matches.length === 0}
              title="Siguiente"
            >
              ↓
            </button>
          </>
        )}
        <span className="conversation-spacer" />
        <ContextMeter usage={usage} fallbackWindow={defaults.contextWindow} compact />
      </div>

      <div className="conversation-scroll" ref={scrollRef} onScroll={onScroll}>
        {hasMore && (
          <button className="conversation-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Cargando...' : 'Cargar mensajes anteriores'}
          </button>
        )}

        {cards.length === 0 && (
          <p className="conversation-empty">
            {state === 'unavailable'
              ? 'Esta pestana no tiene un directorio conocido, asi que no hay archivo de sesion que seguir.'
              : state === 'waiting'
                ? 'Esperando el primer mensaje. El archivo de la sesion se crea cuando la conversacion arranca.'
                : 'La sesion todavia no tiene mensajes.'}
          </p>
        )}

        {blocks.map((block) => {
          if (block.kind === 'card') {
            return (
              <MessageBlock
                key={block.card.event.eventId}
                card={block.card}
                results={results}
                needle={needle}
                isMatch={block.card.event.eventId === activeMatchId}
                copied={copiedId === block.card.event.eventId}
                images={images}
                onRequestImage={requestImage}
                onCopy={() => copyCard(block.card)}
                onRewind={onRewind}
                register={registerCard}
                answered={answered}
                answerFailed={answerFailed}
                onAnswer={answer}
              />
            );
          }

          // Una tanda se abre sola si adentro esta lo que se busca: encontrar
          // algo escondido no sirve de nada.
          const hit = block.cards.some((card) => matched.has(card.event.eventId));

          return (
            <ToolGroup key={block.id} summary={block.summary} at={block.at} open={hit}>
              {block.cards.map((card) => (
                <MessageBlock
                  key={card.event.eventId}
                  card={card}
                  results={results}
                  needle={needle}
                  isMatch={card.event.eventId === activeMatchId}
                  copied={copiedId === card.event.eventId}
                  images={images}
                  onRequestImage={requestImage}
                  onCopy={() => copyCard(card)}
                  onRewind={onRewind}
                  register={registerCard}
                  answered={answered}
                  answerFailed={answerFailed}
                  onAnswer={answer}
                />
              ))}
            </ToolGroup>
          );
        })}
      </div>

      <WaitingBar waitingFor={waitingFor} onGoToCli={onGoToCli} />
    </div>
  );
}

/**
 * La CLI esta esperando una respuesta.
 *
 * Va al pie, entre el hilo y el cuadro de escritura, porque es ahi donde uno
 * mira cuando esta esperando que pase algo.
 *
 * **No dibuja los botones de la pregunta, y no es por falta de ganas.** Lo que
 * llega es que la CLI espera y de que clase; el contenido —que herramienta
 * pidio permiso, con que opciones— no esta en ningun archivo mientras el
 * dialogo esta abierto. Un boton "Permitir" que en realidad manda una tecla a
 * ciegas a un menu que no vimos es peor que un cartel que dice donde esta el
 * menu de verdad.
 */
function WaitingBar({
  waitingFor,
  onGoToCli,
}: {
  waitingFor: string | null;
  onGoToCli: () => void;
}): JSX.Element | null {
  if (waitingFor === null) return null;

  // La unica etiqueta que se traduce, porque es la unica que dice algo
  // accionable. El resto se agrupa: que espera se sabe, de que se trata no.
  const text =
    waitingFor === 'permission prompt'
      ? 'La CLI esta esperando que autorices una herramienta.'
      : 'La CLI esta esperando una respuesta tuya.';

  return (
    <div className="conversation-waiting" role="status">
      <span className="conversation-waiting-dot" aria-hidden="true" />
      <span>{text}</span>
      <button className="link-button" onClick={onGoToCli}>
        Ir a la solapa CLI
      </button>
    </div>
  );
}

interface MessageBlockProps {
  card: Card;
  results: Map<string, ConversationToolResultPart>;
  needle: string;
  isMatch: boolean;
  copied: boolean;
  images: Record<string, string | null>;
  onRequestImage: (eventId: string, index: number, source: ConversationImageSource) => void;
  onCopy: () => void;
  onRewind: () => void;
  register: (eventId: string, element: HTMLElement | null) => void;
  /** Respuestas mandadas desde aca y todavia sin confirmar por el archivo. */
  answered: Record<string, AnswerSelection[]>;
  /** Respuestas que se dieron por perdidas, con el motivo. */
  answerFailed: Record<string, string>;
  onAnswer: (toolUseId: string, selections: AnswerSelection[]) => void;
}

function MessageBlock({
  card,
  results,
  needle,
  isMatch,
  copied,
  images,
  onRequestImage,
  onCopy,
  onRewind,
  register,
  answered,
  answerFailed,
  onAnswer,
}: MessageBlockProps): JSX.Element {
  const { event } = card;
  const mine = event.role === 'user';

  /*
    Una pregunta esta contestada si su `tool_result` ya llego al archivo —lo
    que cubre haber contestado en la solapa CLI— o si se contesto desde aca
    hace un momento. Las dos fuentes hacen falta: la primera es la verdad pero
    tarda, la segunda es inmediata pero solo sabe de los clics propios.
  */
  const answeredFor = (part: ConversationQuestionPart): AnswerSelection[] | null => {
    const own = answered[part.toolUseId];
    if (own !== undefined) return own;
    // Contestada desde la terminal: se sabe que ya no espera, pero no que se
    // eligio. Una lista vacia cierra la tarjeta sin marcar ninguna opcion,
    // que es exactamente lo que se sabe.
    return results.has(part.toolUseId) ? [] : null;
  };

  return (
    <article
      ref={(element) => register(event.eventId, element)}
      className={`turn turn-${event.role}${isMatch ? ' turn-match' : ''}`}
    >
      {/*
        Las acciones aparecen al pasar el mouse, y solo los mensajes propios
        llevan "volver aqui": el rewind se pide sobre *un punto de la
        conversacion*, y ese punto siempre es algo que pedi yo.
      */}
      <div className="turn-actions">
        <button className="icon-button" onClick={onCopy} title="Copiar el texto de este mensaje">
          {copied ? '✓' : '⧉'}
        </button>
        {mine && (
          <button
            className="icon-button"
            onClick={onRewind}
            title="Volver aqui — abre el menu de rewind de la CLI en la pestaña CLI (Esc Esc)"
          >
            ↩
          </button>
        )}
      </div>

      {card.parts.map((part, index) => (
        <PartView
          key={index}
          part={part}
          eventId={event.eventId}
          mine={mine}
          result={part.kind === 'tool-call' ? (results.get(part.toolUseId) ?? null) : null}
          needle={needle}
          images={images}
          onRequestImage={onRequestImage}
          answeredAt={part.kind === 'question' ? answeredFor(part) : null}
          failure={part.kind === 'question' ? (answerFailed[part.toolUseId] ?? null) : null}
          onAnswer={onAnswer}
        />
      ))}

      <TurnFooter event={event} mine={mine} />
    </article>
  );
}

/**
 * Una tanda de acciones, plegada en una linea.
 *
 * Lo que resume no se pierde: adentro estan las mismas tarjetas de siempre,
 * con su entrada y su resultado. Lo que cambia es que quince llamadas seguidas
 * dejan de ocupar quince filas con quince relojes para ocupar una que dice
 * cuantas fueron y de que clase.
 *
 * Se abre sola cuando la busqueda encontro algo adentro, y solo entonces:
 * abrirlas todas al escribir en el buscador devolveria la pantalla que esto
 * viene a evitar.
 */
function ToolGroup({
  summary,
  at,
  open,
  children,
}: {
  summary: string;
  at: number;
  open: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const time = formatTime(at);
  return (
    <details className="tool-group" open={open}>
      <summary className="tool-group-summary">
        <span className="tool-group-chevron" aria-hidden="true">
          ▸
        </span>
        <span className="tool-group-count">{summary}</span>
        {time.length > 0 && <span className="tool-group-time">{time}</span>}
      </summary>
      <div className="tool-group-body">{children}</div>
    </details>
  );
}

/** Hora, duracion y esfuerzo. Todo sale del archivo; nada se deduce. */
function TurnFooter({ event, mine }: { event: ConversationEvent; mine: boolean }): JSX.Element {
  const time = formatTime(event.at);
  const bits: string[] = [];
  if (event.durationMs !== null) bits.push(formatDuration(event.durationMs));
  if (event.effort !== null) bits.push(`esfuerzo ${event.effort}`);

  return (
    <div className="turn-meta">
      {mine && <span className="turn-who">Vos</span>}
      {time.length > 0 && <span>{time}</span>}
      {/*
        Un mensaje encolado no arranco un turno: se lo encontro uno que ya
        estaba corriendo. Sin decirlo, el hilo parece afirmar que el agente lo
        leyo y contesto, y no es lo que paso.
      */}
      {event.queued && (
        <span
          className="turn-queued"
          title="Lo escribiste con el agente trabajando: entro en el turno que ya estaba en curso"
        >
          enviado mientras trabajaba
        </span>
      )}
      {bits.map((bit) => (
        <span key={bit} className="turn-meta-bit">
          {bit}
        </span>
      ))}
    </div>
  );
}

interface PartViewProps {
  part: ConversationPart;
  eventId: string;
  mine: boolean;
  result: ConversationToolResultPart | null;
  needle: string;
  images: Record<string, string | null>;
  onRequestImage: (eventId: string, index: number, source: ConversationImageSource) => void;
  /** Lo elegido para esta pregunta, o null si sigue esperando respuesta. */
  answeredAt: AnswerSelection[] | null;
  /** Motivo por el que la respuesta no llego, si no llego. */
  failure: string | null;
  onAnswer: (toolUseId: string, selections: AnswerSelection[]) => void;
}

function PartView({
  part,
  eventId,
  mine,
  result,
  needle,
  images,
  onRequestImage,
  answeredAt,
  failure,
  onAnswer,
}: PartViewProps): JSX.Element | null {
  switch (part.kind) {
    case 'text':
      // Lo propio va tal cual se escribio —es texto, no un documento— y
      // plegado si es largo. Lo del asistente se renderiza como markdown.
      return mine ? (
        <FoldableText text={part.text} truncated={part.truncated} needle={needle} />
      ) : (
        <div className="part-text">
          <Markdown text={part.text} needle={needle} />
          {part.truncated && <span className="part-truncated"> … (recortado)</span>}
        </div>
      );

    case 'image':
      return (
        <ConversationImage
          eventId={eventId}
          index={part.index}
          source={part.source}
          src={images[imageKey(eventId, part.index, part.source)]}
          onRequest={onRequestImage}
        />
      );

    case 'thinking':
      return null;

    case 'question':
      return (
        <QuestionCard
          part={part}
          answeredAt={answeredAt}
          failure={failure}
          onAnswer={onAnswer}
          needle={needle}
        />
      );

    case 'tool-call': {
      const matchesSearch =
        needle.length > 0 &&
        `${part.name} ${part.input} ${result?.text ?? ''}`
          .toLowerCase()
          .includes(needle.toLowerCase());

      return (
        <details className="tool" open={matchesSearch}>
          <summary className="tool-summary">
            <span className="tool-name">{part.name}</span>
            {result !== null && result.isError && <span className="tool-error">error</span>}
            {result !== null && result.imageCount > 0 && (
              <span className="tool-images">{result.imageCount} img</span>
            )}
          </summary>

          <div className="tool-block">
            <span className="tool-label">entrada</span>
            <pre className="tool-pre">
              {highlight(part.input, needle)}
              {part.truncated && <span className="part-truncated"> … (recortado)</span>}
            </pre>
          </div>

          {result !== null && (
            <div className="tool-block">
              <span className="tool-label">resultado</span>
              <pre className={`tool-pre${result.isError ? ' tool-pre-error' : ''}`}>
                {result.text.length > 0
                  ? highlight(result.text, needle)
                  : result.imageCount > 0
                    ? `(${result.imageCount} imagen(es): no se transportan al panel)`
                    : '(sin salida)'}
                {result.truncated && <span className="part-truncated"> … (recortado)</span>}
              </pre>
            </div>
          )}
        </details>
      );
    }

    case 'tool-result':
      // Solo llega aca si su llamada no esta cargada (quedo antes del tramo).
      return (
        <div className="tool-block">
          <span className="tool-label">resultado suelto</span>
          <pre className={`tool-pre${part.isError ? ' tool-pre-error' : ''}`}>
            {highlight(part.text, needle)}
          </pre>
        </div>
      );
  }
}

/**
 * Una pregunta de eleccion, contestable desde el hilo.
 *
 * Es la unica tarjeta de la conversacion que no cuenta algo que ya paso, sino
 * que espera una accion. Antes caia en el render generico de herramienta —el
 * nombre colapsado y el JSON crudo adentro— asi que la pregunta llegaba
 * ilegible y la unica forma de contestar era irse a la solapa CLI.
 *
 * Dos modos, y la diferencia es el numero de clics del caso comun:
 *
 *  - **Una pregunta de opcion unica** —la enorme mayoria— se manda con el
 *    clic. Pedir un "enviar" despues de elegir seria un paso de mas para nada.
 *  - **Varias preguntas, o una de opcion multiple**, acumulan aca y se mandan
 *    juntas. No es capricho: el menu de la CLI solo se puede responder desde el
 *    principio y de corrido (ver `buildAnswerKeys`), asi que la seleccion tiene
 *    que estar completa antes de escribir la primera tecla.
 *
 * Y desde el hito 16, **se puede escribir en vez de elegir**. La CLI ofrece
 * `Type something` al final de cada pregunta, y hasta ahora eso obligaba a irse
 * a la solapa CLI — justo lo que la tarjeta viene a evitar, y para un caso
 * comun: agregar una alternativa que no esta, o explicar por que ninguna
 * sirve. Va como una opcion mas al final de la lista, porque eso es
 * exactamente lo que es para la CLI (§5.5).
 *
 * Una vez respondida deja de aceptar clics. La CLI ya cerro el menu, y un
 * segundo envio escribiria numeros sueltos en el prompt. La excepcion es una
 * respuesta que **no se confirmo**: ahi la tarjeta lo dice y se vuelve a
 * abrir, porque dejarla cerrada seria afirmar que se contesto algo que nadie
 * recibio.
 */
function QuestionCard({
  part,
  answeredAt,
  failure,
  onAnswer,
  needle,
}: {
  part: ConversationQuestionPart;
  answeredAt: AnswerSelection[] | null;
  failure: string | null;
  onAnswer: (toolUseId: string, selections: AnswerSelection[]) => void;
  needle: string;
}): JSX.Element {
  const [draft, setDraft] = useState<AnswerSelection[]>(() => part.questions.map(() => []));
  /** Que pregunta tiene el cuadro de texto abierto, si alguna. */
  const [writing, setWriting] = useState<number | null>(null);
  const [text, setText] = useState('');

  const done = answeredAt !== null;
  const chosen = answeredAt ?? draft;
  const oneShot = part.questions.length === 1 && part.questions[0]?.multiSelect === false;
  const complete = chosen.every((selection) =>
    isFree(selection) ? selection.text.trim().length > 0 : selection.length > 0,
  );

  /** Los indices elegidos, o ninguno si esa pregunta se contesto escribiendo. */
  const indices = (selection: AnswerSelection | undefined): number[] =>
    selection === undefined || isFree(selection) ? [] : selection;

  const toggle = (questionIndex: number, optionIndex: number): void => {
    if (done) return;
    const question = part.questions[questionIndex];
    if (question === undefined) return;

    if (oneShot) {
      onAnswer(part.toolUseId, [[optionIndex]]);
      return;
    }

    setWriting((current) => (current === questionIndex ? null : current));
    setDraft((current) =>
      current.map((selection, index) => {
        if (index !== questionIndex) return selection;
        const previous = indices(selection);
        if (!question.multiSelect) return [optionIndex];
        return previous.includes(optionIndex)
          ? previous.filter((entry) => entry !== optionIndex)
          : [...previous, optionIndex];
      }),
    );
  };

  /**
   * Guarda lo escrito como respuesta de esa pregunta.
   *
   * Con una sola pregunta de opcion unica se manda en el acto, igual que el
   * clic en una opcion: para la CLI son la misma accion.
   */
  const commitText = (questionIndex: number): void => {
    const clean = text.trim();
    if (clean.length === 0) return;
    const free: AnswerSelection = { kind: 'free', text: clean };

    if (oneShot) {
      onAnswer(part.toolUseId, [free]);
      return;
    }
    setDraft((current) =>
      current.map((selection, index) => (index === questionIndex ? free : selection)),
    );
    setWriting(null);
    setText('');
  };

  const openWriting = (questionIndex: number): void => {
    if (done) return;
    const current = chosen[questionIndex];
    setText(current !== undefined && isFree(current) ? current.text : '');
    setWriting(questionIndex);
  };

  return (
    <div className={`question${done ? ' question-done' : ''}`}>
      {part.questions.map((question, questionIndex) => {
        const selection = chosen[questionIndex];
        const written = selection !== undefined && isFree(selection) ? selection.text : null;

        return (
          <div key={questionIndex} className="question-item">
            <div className="question-head">
              {question.header.length > 0 && (
                <span className="question-header">{question.header}</span>
              )}
              <span className="question-text">{highlight(question.question, needle)}</span>
              {question.multiSelect && <span className="question-hint">varias</span>}
            </div>

            <div className="question-options">
              {question.options.map((option, optionIndex) => {
                const picked = indices(selection).includes(optionIndex);
                return (
                  <button
                    key={optionIndex}
                    type="button"
                    className={`question-option${picked ? ' question-option-picked' : ''}`}
                    disabled={done}
                    onClick={() => toggle(questionIndex, optionIndex)}
                  >
                    <span className="question-option-label">{option.label}</span>
                    {option.description.length > 0 && (
                      <span className="question-option-desc">{option.description}</span>
                    )}
                  </button>
                );
              })}

              {/*
                La respuesta propia, al final y con la misma forma que las
                demas: para la CLI es una opcion mas del menu, la que sigue a
                las reales.
              */}
              {writing === questionIndex && !done ? (
                <div className="question-write">
                  <textarea
                    className="question-write-input"
                    autoFocus
                    rows={2}
                    value={text}
                    placeholder="Escribi tu respuesta"
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter confirma, Shift+Enter salta de linea: lo mismo
                      // que en el cuadro de escritura, y por lo mismo.
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        commitText(questionIndex);
                      }
                      if (event.key === 'Escape') setWriting(null);
                      event.stopPropagation();
                    }}
                  />
                  <div className="question-write-actions">
                    <button
                      type="button"
                      className="question-send"
                      disabled={text.trim().length === 0}
                      onClick={() => commitText(questionIndex)}
                    >
                      {oneShot ? 'Enviar' : 'Usar este texto'}
                    </button>
                    <button
                      type="button"
                      className="question-write-cancel"
                      onClick={() => setWriting(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={`question-option question-option-write${
                    written !== null ? ' question-option-picked' : ''
                  }`}
                  disabled={done}
                  onClick={() => openWriting(questionIndex)}
                >
                  <span className="question-option-label">
                    {written !== null ? written : 'Escribir otra respuesta…'}
                  </span>
                  {written === null && (
                    <span className="question-option-desc">
                      Para proponer una alternativa, o dar mas contexto
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div className="question-foot">
        {failure !== null && <span className="question-failed">{failure}</span>}
        {done ? (
          <span className="question-sent">Respondida</span>
        ) : (
          <>
            {!oneShot && (
              <button
                type="button"
                className="question-send"
                disabled={!complete}
                onClick={() => onAnswer(part.toolUseId, draft)}
              >
                Enviar respuestas
              </button>
            )}
            <span className="question-note">
              {oneShot ? 'Elegí una opción' : 'Elegí en cada pregunta'} · también podés
              responder en la solapa CLI
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Texto propio, plegado si pasa de cuatro lineas.
 *
 * Se pliega **la vista**, no el dato: lo que se mando esta entero y se
 * despliega de un clic. Una coincidencia de la busqueda lo abre sola, porque
 * encontrar algo escondido no sirve de nada.
 */
function FoldableText({
  text,
  truncated,
  needle,
}: {
  text: string;
  truncated: boolean;
  needle: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const matched = needle.length > 0 && text.toLowerCase().includes(needle.toLowerCase());
  const foldable = lines.length >= FOLD_FROM_LINES && !matched;
  const visible = foldable && !open ? lines.slice(0, FOLD_FROM_LINES - 1).join('\n') : text;

  return (
    <div className="part-text part-mine">
      {highlight(visible, needle)}
      {truncated && <span className="part-truncated"> … (recortado)</span>}
      {foldable && (
        <button className="fold-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? 'ver menos' : `ver las ${lines.length} lineas`}
        </button>
      )}
    </div>
  );
}

/**
 * Miniatura de una imagen del mensaje. Los bytes se piden al aparecer.
 *
 * Sirve para las dos formas en que una imagen llega al archivo: pegada en la
 * solapa CLI (`content`) o adjuntada por ruta desde el cuadro de escritura
 * (`attachment`). Lo unico que cambia es donde buscarla, y de eso se encarga el
 * servidor; aca `source` solo viaja para pedirla.
 *
 * El clic abre el visor, no agranda en el sitio. Agrandar en el sitio movia la
 * conversacion bajo el cursor en el mismo clic — ver `ImageViewer`.
 */
function ConversationImage({
  eventId,
  index,
  source,
  src,
  onRequest,
}: {
  eventId: string;
  index: number;
  source: ConversationImageSource;
  src: string | null | undefined;
  onRequest: (eventId: string, index: number, source: ConversationImageSource) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (src === undefined) onRequest(eventId, index, source);
  }, [src, eventId, index, source, onRequest]);

  if (src === undefined) {
    return <div className="conversation-image-placeholder">cargando imagen…</div>;
  }
  if (src === null) {
    return <div className="conversation-image-placeholder">la imagen ya no esta en el archivo</div>;
  }

  return (
    <>
      <img
        className="conversation-image"
        src={src}
        alt="imagen del mensaje"
        onClick={() => setOpen(true)}
        title="Clic para verla entera"
      />
      {open && (
        <ImageViewer src={src} caption="imagen del mensaje" onClose={() => setOpen(false)} />
      )}
    </>
  );
}
