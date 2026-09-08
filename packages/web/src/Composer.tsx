/**
 * El cuadro de escritura de la conversacion.
 *
 * Es lo unico de la aplicacion que le escribe a la CLI sin ser el teclado de la
 * terminal, y por eso tiene reglas propias. Ninguna de ellas le quita nada a la
 * terminal: quien escriba en la pestana CLI sigue teniendo `Ctrl+V`, `Alt+V`,
 * `Esc Esc` y todo lo demas intacto (CLAUDE.md 5). Esto es otro widget.
 *
 *  - **Enter envia. Shift+Enter salta de linea.** Al reves de lo que hace la
 *    terminal, donde el salto pide `Ctrl+J`. Es la razon de que exista este
 *    cuadro: el servidor manda el texto como un *pegado*, y adentro de un
 *    pegado los saltos de linea son texto y no un envio.
 *  - **`Ctrl+V` con una imagen deja una miniatura**, no un `Alt+V` disfrazado.
 *    La imagen viaja por el socket, el servidor la escribe en disco y se la
 *    nombra a la CLI por ruta.
 *  - **Un pegado de mas de cuatro lineas se pliega** en una ficha. Se manda
 *    entero; lo que se pliega es como se ve mientras se escribe.
 *  - **`Esc` interrumpe**, igual que en la terminal, y no borra lo escrito.
 *
 * El orden de lo que se envia es el que se ve en pantalla: las fichas primero,
 * en el orden en que se pegaron, y despues lo escrito. Que coincida con la
 * pantalla es lo unico que lo hace predecible.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalId } from '@agent-workbench/shared';
import { ImageViewer } from './ImageViewer.js';
import { useComposerAttachments, type Attachment } from './useComposerAttachments.js';
import { useDragSize } from './useDragSize.js';
import { parseStoredSize, readStored, writeStored } from './window-prefs.js';
import type { AgentConnection } from './connection.js';

/*
  El alto del cuadro.

  Crece con lo que se escribe y se detiene en un tope. Ese tope **se arrastra**
  desde el hito 19: un pedido largo entraba en 260 px solo con scroll, y
  releerlo antes de mandarlo obligaba a recorrerlo de a cuatro lineas.

  Lo arrastrable es el tope, no el alto: el cuadro sigue midiendo lo que mide el
  texto. Un cuadro que se queda grande con dos palabras escritas le come a la
  conversacion el sitio que necesita justo cuando no hace falta.
*/
const MIN_TEXTAREA_PX = 90;
const DEFAULT_TEXTAREA_PX = 260;
const MAX_TEXTAREA_PX = 720;
const TEXTAREA_HEIGHT_KEY = 'agent-workbench.composer-height';

/** Cuantas lineas de un texto plegado se ven al desplegarlo, como maximo. */
const PREVIEW_CHARS = 4_000;

/** Lo que queda escrito en una pestana y todavia no se mando. */
interface Draft {
  text: string;
  items: Attachment[];
}

interface ComposerProps {
  connection: AgentConnection;
  terminalId: TerminalId | null;
  /** false si el proceso de la pestana termino: no hay a quien escribirle. */
  alive: boolean;
  /** Controles extra a la derecha de la barra (modelo, esfuerzo). */
  controls?: JSX.Element;
  /**
   * Controles a la izquierda, antes del hueco (modo de permiso).
   *
   * Estan de ese lado porque se miran **antes** de escribir: el modo decide
   * cuanto puede hacer el agente sin preguntar. Lo de la derecha se elige una
   * vez y se olvida.
   */
  leading?: JSX.Element;
}

export function Composer({
  connection,
  terminalId,
  alive,
  controls,
  leading,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const attachments = useComposerAttachments();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ---- alto del cuadro ----

  const [maxHeight, setMaxHeight] = useState(() =>
    readStored(TEXTAREA_HEIGHT_KEY, DEFAULT_TEXTAREA_PX, (raw) =>
      parseStoredSize(raw, MIN_TEXTAREA_PX, MAX_TEXTAREA_PX),
    ),
  );
  const [resizing, setResizing] = useState(false);

  /**
   * El cuadro crece con el texto y se detiene en el tope arrastrado.
   *
   * Mientras se arrastra se pinta **al tope**, aunque el texto no llegue. Sin
   * eso el gesto no contesta nada cuando el cuadro esta corto —el tope todavia
   * no se ve— y el divisor parece roto. Al soltar vuelve a ajustarse al
   * contenido, que es lo que hace siempre.
   */
  const resize = useCallback(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = 'auto';
    const height = resizing ? maxHeight : Math.min(element.scrollHeight, maxHeight);
    element.style.height = `${height}px`;
  }, [maxHeight, resizing]);

  useEffect(resize, [text, resize]);

  /*
    El divisor mide contra el borde de **abajo** del cuadro, que no se mueve: el
    cuadro de escritura esta al pie y crece hacia arriba. Entre el divisor y ese
    borde puede haber fichas de adjuntos, asi que el desfase se toma al agarrar
    y se descuenta; sin eso el alto pega un salto en el primer movimiento.
  */
  const anchor = useRef(0);
  const offset = useRef(0);

  const heightDivider = useDragSize({
    min: MIN_TEXTAREA_PX,
    max: MAX_TEXTAREA_PX,
    value: maxHeight,
    measure: useCallback(
      (event: React.PointerEvent<HTMLDivElement>) =>
        anchor.current - event.clientY - offset.current,
      [],
    ),
    onChange: setMaxHeight,
    onCommit: useCallback((value: number) => {
      setResizing(false);
      writeStored(TEXTAREA_HEIGHT_KEY, String(value));
    }, []),
    onStart: useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      const element = textareaRef.current;
      const box = element?.getBoundingClientRect();
      anchor.current = box?.bottom ?? event.clientY;
      offset.current = (box?.bottom ?? event.clientY) - event.clientY - (box?.height ?? 0);
      setResizing(true);
    }, []),
  });

  /*
    Lo escrito y sin enviar pertenece a la pestana donde se escribio.

    El cuadro es uno solo y sobrevive al cambio de pestana, asi que sin esto el
    borrador de una conversacion reaparece en la siguiente y se manda donde no
    era. Se guarda al salir y se restaura al volver: mirar otra pestana no
    cuesta el mensaje que uno estaba redactando.

    Los adjuntos viajan en el mismo borrador. Una imagen pegada que se cuela en
    otra conversacion es la misma falla y peor, porque se adjunta sin que se
    note.

    El foco tambien vuelve aca al cambiar de pestana: antes se lo llevaba la
    terminal, que era lo correcto cuando la terminal era la pantalla. Ahora se
    abre una pestana para escribirle algo al agente.
  */
  const drafts = useRef(new Map<TerminalId, Draft>());
  const shown = useRef<TerminalId | null>(null);

  // Espejos de lo ultimo escrito. El efecto de abajo no puede depender de
  // `text` ni de `attachments` —cambian en cada tecla— pero necesita su valor
  // actual en el momento de dejar la pestana.
  const textRef = useRef(text);
  textRef.current = text;
  const itemsRef = useRef(attachments.items);
  itemsRef.current = attachments.items;

  const { replace: replaceAttachments } = attachments;

  useEffect(() => {
    const previous = shown.current;
    if (previous === terminalId) return;
    shown.current = terminalId;

    if (previous !== null) {
      drafts.current.set(previous, { text: textRef.current, items: itemsRef.current });
    }

    const draft = terminalId === null ? undefined : drafts.current.get(terminalId);
    setText(draft?.text ?? '');
    replaceAttachments(draft?.items ?? []);

    if (terminalId !== null) textareaRef.current?.focus();
  }, [terminalId, replaceAttachments]);

  const submit = useCallback(() => {
    if (terminalId === null) return;

    const folded = attachments.items
      .filter((item): item is Extract<Attachment, { kind: 'text' }> => item.kind === 'text')
      .map((item) => item.text);
    const images = attachments.items
      .filter((item): item is Extract<Attachment, { kind: 'image' }> => item.kind === 'image')
      .map((item) => ({ mediaType: item.mediaType, data: item.base64 }));

    const body = [...folded, text].filter((piece) => piece.trim().length > 0).join('\n\n');
    if (body.length === 0 && images.length === 0) return;

    connection.send({ type: 'agent.submit', terminalId, text: body, images });
    setText('');
    attachments.clear();
  }, [connection, terminalId, text, attachments]);

  const interrupt = useCallback(() => {
    if (terminalId === null) return;
    connection.send({ type: 'agent.interrupt', terminalId });
  }, [connection, terminalId]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        interrupt();
      }
    },
    [submit, interrupt],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (event.clipboardData === null) return;
      // Solo se intercepta lo que no cabe en el cuadro. Un pegado corriente lo
      // sigue haciendo el navegador, con su deshacer y su cursor.
      if (attachments.acceptPaste(event.clipboardData)) event.preventDefault();
    },
    [attachments],
  );

  const disabled = terminalId === null || !alive;
  const hasSomething = text.trim().length > 0 || attachments.items.length > 0;

  return (
    <div
      className={`composer${dragging ? ' composer-dragging' : ''}`}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        attachments.acceptFiles(event.dataTransfer.files);
      }}
    >
      {/*
        El borde de arriba es el tirador del alto. Esta siempre, no solo cuando
        el texto desborda: un tirador que aparece y desaparece es un blanco
        movil justo debajo del mouse. Es el mismo gesto que los otros tres
        divisores de la ventana, y por eso comparte `useDragSize`.
      */}
      <div
        className="hdivider composer-divider"
        {...heightDivider}
        title="Arrastrar para cambiar el alto del cuadro"
      />

      {attachments.problem !== null && (
        <div className="composer-problem">
          <span>{attachments.problem}</span>
          <button className="icon-button" onClick={attachments.dismissProblem} title="Cerrar">
            ×
          </button>
        </div>
      )}

      {attachments.items.length > 0 && (
        <div className="composer-chips">
          {attachments.items.map((item) => (
            <AttachmentChip key={item.id} item={item} onRemove={() => attachments.remove(item.id)} />
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="composer-input"
        value={text}
        rows={1}
        /*
          El placeholder dice que va aca, no como se usa el teclado. Listaba
          "Enter envia, Shift+Enter salta de linea" y es el mismo caso del
          cartel de atajos de mas abajo: se aprende la primera vez y despues
          ocupa la unica linea que tiene el cuadro cuando esta vacio. Los dos
          siguen en el dialogo del boton `?`.
        */
        placeholder={
          disabled ? 'La sesion de esta pestana termino.' : 'Escribi tu mensaje.'
        }
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck={false}
      />

      {/*
        Sin cartel de atajos.

        Estaba aca abajo listando Enter, Shift+Enter y Ctrl+V, y ocupaba una
        fila permanente para algo que se aprende la primera vez y despues es
        ruido. Los tres siguen documentados en el dialogo del boton `?`, que es
        donde se busca un atajo cuando de verdad hace falta.
      */}
      <div className="composer-bar">
        {leading}
        <span className="composer-spacer" />
        {controls}
        <button
          className="composer-stop"
          onClick={interrupt}
          disabled={disabled}
          title="Interrumpir lo que la CLI este haciendo (Esc)"
        >
          Detener
        </button>
        <button
          className="composer-send"
          onClick={submit}
          disabled={disabled || !hasSomething}
          title="Enviar (Enter)"
        >
          Enviar
        </button>
      </div>
    </div>
  );
}

interface AttachmentChipProps {
  item: Attachment;
  onRemove: () => void;
}

function AttachmentChip({ item, onRemove }: AttachmentChipProps): JSX.Element {
  const [open, setOpen] = useState(false);

  if (item.kind === 'image') {
    /*
      La miniatura mide 56 px de alto: alcanza para saber cual es, no para
      leerla. El clic la abre entera en el visor, que va superpuesto y no en el
      sitio — agrandar la ficha empujaria hacia abajo el texto que uno esta
      escribiendo.
    */
    const label = `${item.name} · ${formatBytes(item.bytes)}`;
    return (
      <figure className="chip chip-image" title={label}>
        <img src={item.dataUrl} alt={item.name} onClick={() => setOpen(true)} />
        <button className="chip-remove" onClick={onRemove} title="Quitar">
          ×
        </button>
        {open && (
          <ImageViewer src={item.dataUrl} caption={label} onClose={() => setOpen(false)} />
        )}
      </figure>
    );
  }

  return (
    <div className={`chip chip-text${open ? ' chip-open' : ''}`}>
      <button className="chip-toggle" onClick={() => setOpen((value) => !value)}>
        <span className="chip-icon">¶</span>
        Texto pegado · {item.lines} lineas
        <span className="chip-chevron">{open ? '▾' : '▸'}</span>
      </button>
      <button className="chip-remove" onClick={onRemove} title="Quitar">
        ×
      </button>
      {open && <pre className="chip-preview">{item.text.slice(0, PREVIEW_CHARS)}</pre>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
