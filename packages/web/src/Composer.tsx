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
 *    entero; lo que se pliega es como se ve mientras se escribe. Desde el hito
 *    35 lleva un numero, deja su marca (`[Pasted text #1]`) donde estaba el
 *    cursor y se edita en la misma ficha (§6.24).
 *  - **`Esc` interrumpe**, igual que en la terminal, y no borra lo escrito.
 *
 * El orden de lo que se envia es el que se ve en pantalla: las fichas primero,
 * en el orden en que se pegaron, cada una entre su linea de inicio y la de fin,
 * y despues lo escrito, con las marcas donde se pego (`assembleMessage`). Que
 * coincida con la pantalla es lo unico que lo hace predecible.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';
import { mergePrefill } from './agent-ui.js';
import {
  assembleMessage,
  insertPasteReference,
  pastedChipLabel,
  referencedPasteNumbers,
  removePasteReferences,
} from './composer-paste.js';
import { formatBytes } from './i18n/format.js';
import { t } from './i18n/index.js';
import { ImageViewer } from './ImageViewer.js';
import type { ComposerPrefill } from './useWorkspace.js';
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

/** Lo que queda escrito en una pestana y todavia no se mando. */
interface Draft {
  text: string;
  items: Attachment[];
}

/**
 * Los borradores, por pestana, **fuera del componente**: cambiar de ancho
 * cambia de cascaron (hito 38, §6.25) y el cuadro se vuelve a montar. Con el
 * mapa adentro, el mensaje a medio escribir se perdia en ese cambio.
 */
const DRAFTS = new Map<TerminalId, Draft>();

interface ComposerProps {
  connection: AgentConnection;
  terminalId: TerminalId | null;
  /** false si la pestana no tiene CLI corriendo: no hay a quien escribirle. */
  alive: boolean;
  /**
   * true si la pestana esta dormida —restaurada y sin proceso— en vez de
   * terminada. Cambia lo que dice el cuadro: una espera que la abras, la otra
   * ya corrio y se murio.
   */
  sleeping?: boolean;
  /**
   * Que hace la CLI de la pestana. "Detener" se dibuja solo si puede haber
   * algo que detener: trabajando, esperando, o sin estado conocido (una CLI
   * que no lo publica). Libre, el boton no tiene sentido y le quita lugar a
   * "Enviar" en pantallas angostas.
   */
  activity?: TerminalActivity;
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
  /**
   * false si la CLI de la pestana no recibe imagenes por ruta: pegar o soltar
   * una lo avisa en vez de dejar una miniatura que no se va a poder mandar.
   */
  imagesAllowed?: boolean;
  /**
   * Por que no se puede mandar ahora, o null. Enviar se apaga y el titulo lo
   * dice; lo escrito se queda y se puede seguir escribiendo.
   *
   * Hoy lo usa una sola cosa: una CLI que no publica su estado con una llamada
   * a herramienta abierta, que puede ser un menu de aprobacion esperando. Ahi
   * un mensaje llegaria como teclas al menu, y el Enter final aprueba.
   */
  blockedReason?: string | null;
  /**
   * Textos que llegaron del servidor para el cuadro de alguna pestana (hito 29:
   * la continuacion de una conversacion que no se manda sola). Se escriben en
   * el borrador de **esa** pestana, este a la vista o no, y nunca se mandan.
   */
  prefills?: readonly ComposerPrefill[];
  /** Ya se escribio ese texto: el espacio de trabajo lo olvida. */
  onPrefillApplied?: (id: number) => void;
  /**
   * Un aviso encima del cuadro, con su ×, o null. Hoy, el de una continuacion:
   * lo que el agente no tiene del contexto de la otra CLI.
   */
  notice?: { text: string; status: string | null } | null;
  onDismissNotice?: () => void;
  /** Se mando algo desde el cuadro de esa pestana. */
  onSubmitted?: (terminalId: TerminalId) => void;
}

export function Composer({
  connection,
  terminalId,
  alive,
  sleeping = false,
  activity,
  controls,
  leading,
  imagesAllowed = true,
  blockedReason = null,
  prefills,
  onPrefillApplied,
  notice = null,
  onDismissNotice,
  onSubmitted,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const attachments = useComposerAttachments(imagesAllowed);
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
      DRAFTS.set(previous, { text: textRef.current, items: itemsRef.current });
    }

    const draft = terminalId === null ? undefined : DRAFTS.get(terminalId);
    setText(draft?.text ?? '');
    replaceAttachments(draft?.items ?? []);

    if (terminalId !== null) textareaRef.current?.focus();
  }, [terminalId, replaceAttachments]);

  // Al desmontar —cambio de cascaron— lo escrito queda guardado para la vuelta.
  useEffect(
    () => () => {
      const current = shown.current;
      if (current !== null) DRAFTS.set(current, { text: textRef.current, items: itemsRef.current });
    },
    [],
  );

  /*
    Un texto prellenado (hito 29) va al borrador de su pestana: al cuadro si es
    la que se muestra, y al borrador guardado si no —la pestana nueva de una
    continuacion puede no estar a la vista todavia—. Solo si esta vacio; si no,
    antes de lo escrito y con una linea en blanco (`mergePrefill`).

    Va **despues** del efecto de cambio de pestana, a proposito: si los dos
    corren en la misma pasada, la pestana nueva ya quedo a la vista y el texto
    cae en su cuadro, no en el borrador de la anterior.
  */
  const appliedPrefills = useRef(new Set<number>());
  useEffect(() => {
    if (prefills === undefined || prefills.length === 0) return;
    for (const prefill of prefills) {
      if (appliedPrefills.current.has(prefill.id)) continue;
      appliedPrefills.current.add(prefill.id);
      if (prefill.terminalId === shown.current) {
        setText((current) => mergePrefill(current, prefill.text));
      } else {
        const draft = DRAFTS.get(prefill.terminalId);
        DRAFTS.set(prefill.terminalId, {
          text: mergePrefill(draft?.text ?? '', prefill.text),
          items: draft?.items ?? [],
        });
      }
      onPrefillApplied?.(prefill.id);
    }
  }, [prefills, onPrefillApplied]);

  const submit = useCallback(() => {
    if (terminalId === null || blockedReason !== null) return;

    const folded = attachments.items
      .filter((item): item is Extract<Attachment, { kind: 'text' }> => item.kind === 'text')
      .map((item) => ({ number: item.number, text: item.text }));
    const images = attachments.items
      .filter((item): item is Extract<Attachment, { kind: 'image' }> => item.kind === 'image')
      .map((item) => ({ mediaType: item.mediaType, data: item.base64 }));
    const files = attachments.items
      .filter((item): item is Extract<Attachment, { kind: 'file' }> => item.kind === 'file')
      .map((item) => ({ name: item.name, data: item.base64 }));

    const body = assembleMessage(folded, text);
    if (body.length === 0 && images.length === 0 && files.length === 0) return;

    // `files` solo viaja si hay: sin adjuntos el mensaje es el de siempre.
    connection.send({
      type: 'agent.submit',
      terminalId,
      text: body,
      images,
      ...(files.length > 0 ? { files } : {}),
    });
    setText('');
    attachments.clear();
    onSubmitted?.(terminalId);
  }, [connection, terminalId, text, attachments, blockedReason, onSubmitted]);

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

  /*
    La marca de un texto pegado va donde estaba el cursor, reemplazando lo
    seleccionado, como un pegado cualquiera. Se escribe con `insertText` para que
    el navegador la trate como algo tecleado: Ctrl+Z la saca, y `onChange` avisa
    como siempre. Si el navegador no lo acepta, `setRangeText`, sin deshacer.
  */
  const insertReference = useCallback((element: HTMLTextAreaElement, n: number) => {
    const { inserted } = insertPasteReference(element.value, element.selectionStart, element.selectionEnd, n);
    let done = false;
    try {
      done = document.execCommand('insertText', false, inserted);
    } catch {
      done = false;
    }
    if (!done) {
      element.setRangeText(inserted, element.selectionStart, element.selectionEnd, 'end');
      setText(element.value);
    }
  }, []);

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (event.clipboardData === null) return;
      // Solo se intercepta lo que no cabe en el cuadro. Un pegado corriente lo
      // sigue haciendo el navegador, con su deshacer y su cursor.
      const result = attachments.acceptPaste(event.clipboardData, referencedPasteNumbers(event.currentTarget.value));
      if (!result.consumed) return;
      event.preventDefault();
      if (result.pastedNumber !== null) insertReference(event.currentTarget, result.pastedNumber);
    },
    [attachments, insertReference],
  );

  // Quitar la ficha de un texto pegado borra tambien su marca: no puede quedar
  // nombrando un texto que ya no se manda.
  const removeAttachment = useCallback(
    (item: Attachment) => {
      attachments.remove(item.id);
      if (item.kind === 'text') setText((current) => removePasteReferences(current, item.number));
    },
    [attachments],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const disabled = terminalId === null || !alive;
  // Una ficha de texto que se vacio al editarla no se manda: sola, no habilita Enviar.
  const hasSomething =
    text.trim().length > 0 ||
    attachments.items.some((item) => item.kind !== 'text' || item.text.trim().length > 0);
  const showStop = alive && activity !== 'idle';
  const showSend = hasSomething || !showStop;

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
        title={t('composer.resizeTitle')}
      />

      {notice !== null && (
        <div className="handoff-notice" role="status">
          <span className="handoff-notice-text">
            {notice.text}
            {notice.status !== null && <span className="handoff-notice-status">{notice.status}</span>}
          </span>
          {onDismissNotice !== undefined && (
            <button className="icon-button" onClick={onDismissNotice} title={t('common.dismissNotice')}>
              ×
            </button>
          )}
        </div>
      )}

      {attachments.problem !== null && (
        <div className="composer-problem">
          <span>{attachments.problem}</span>
          <button className="icon-button" onClick={attachments.dismissProblem} title={t('common.close')}>
            ×
          </button>
        </div>
      )}

      {attachments.items.length > 0 && (
        <div className="composer-chips">
          {attachments.items.map((item) => (
            <AttachmentChip
              key={item.id}
              item={item}
              onRemove={() => removeAttachment(item)}
              onEdit={(value) => attachments.updateText(item.id, value)}
              onDoneEditing={() => textareaRef.current?.focus()}
            />
          ))}
        </div>
      )}

      {/*
        Enviar y Detener son íconos dentro del cuadro, abajo a la derecha: como
        botones de texto ocupaban una fila entera en el teléfono. Detener
        aparece mientras el agente trabaja y Enviar cuando hay algo escrito;
        con el agente trabajando y un texto listo, los dos, porque mandar
        mientras trabaja sigue valiendo. Con el cuadro vacío y el agente
        quieto, Enviar queda apagado: el lugar no salta al escribir.
      */}
      <div className={`composer-field${showStop && showSend ? ' composer-field-two' : ''}`}>
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
          !disabled
            ? t('composer.placeholder.ready')
            : sleeping
              ? t('composer.placeholder.sleeping')
              : t('composer.placeholder.ended')
        }
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck={false}
      />
        <div className="composer-field-actions">
          {showStop && (
            <button
              className="composer-icon composer-stop"
              onClick={interrupt}
              disabled={disabled}
              title={t('composer.stopTitle')}
              aria-label={t('composer.stop')}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            </button>
          )}
          {showSend && (
            <button
              className="composer-icon composer-send"
              onClick={submit}
              disabled={disabled || !hasSomething || blockedReason !== null}
              title={blockedReason ?? t('composer.sendTitle')}
              aria-label={t('composer.send')}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  d="M12 19V5M5.5 11.5 12 5l6.5 6.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/*
        Sin cartel de atajos.

        Estaba aca abajo listando Enter, Shift+Enter y Ctrl+V, y ocupaba una
        fila permanente para algo que se aprende la primera vez y despues es
        ruido. Los tres siguen documentados en el dialogo del boton `?`, que es
        donde se busca un atajo cuando de verdad hace falta.
      */}
      <div className="composer-bar">
        {/*
          Adjuntar (hito 33, §6.21). El gesto ya existia —soltar o pegar— pero
          sin un boton no se encuentra. El `<input>` va escondido y se vacia
          despues de cada eleccion: si no, elegir dos veces el mismo archivo no
          dispara `change` la segunda.
        */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files !== null) attachments.acceptFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          className="icon-button composer-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title={t('composer.attachTitle')}
          aria-label={t('composer.attach')}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M21.4 11.1 12.3 20.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {leading}
        <span className="composer-spacer" />
        {controls}
      </div>
    </div>
  );
}

interface AttachmentChipProps {
  item: Attachment;
  onRemove: () => void;
  /** El texto nuevo de un texto pegado, editado en su ficha. */
  onEdit: (text: string) => void;
  /** Se cerro la ficha con Esc: el foco vuelve al cuadro. */
  onDoneEditing: () => void;
}

function AttachmentChip({ item, onRemove, onEdit, onDoneEditing }: AttachmentChipProps): JSX.Element {
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
        <button className="chip-remove" onClick={onRemove} title={t('composer.chip.remove')}>
          ×
        </button>
        {open && (
          <ImageViewer src={item.dataUrl} caption={label} onClose={() => setOpen(false)} />
        )}
      </figure>
    );
  }

  if (item.kind === 'file') {
    // Sin desplegable: un PDF o un .docx no tienen primeras lineas que mostrar.
    return (
      <div className="chip chip-text chip-file" title={`${item.name} · ${formatBytes(item.bytes)}`}>
        <span className="chip-toggle chip-file-label">
          <span className="chip-icon">▤</span>
          <span className="chip-file-name">{item.name}</span>
          <span className="chip-file-size">{formatBytes(item.bytes)}</span>
        </span>
        <button className="chip-remove" onClick={onRemove} title={t('composer.chip.remove')}>
          ×
        </button>
      </div>
    );
  }

  /*
    Abierta, la ficha es un cuadro editable con el texto entero (hito 35): lo
    que se cambia ahi es lo que se manda. Enter es un salto de linea, no un
    envio, y Esc cierra la ficha sin interrumpir al agente — el Esc que
    interrumpe es el del cuadro de escritura.
  */
  return (
    <div className={`chip chip-text${open ? ' chip-open' : ''}`}>
      <button
        className="chip-toggle"
        onClick={() => setOpen((value) => !value)}
        title={t('composer.chip.editHint')}
        aria-expanded={open}
      >
        <span className="chip-icon">¶</span>
        {pastedChipLabel(item.number, item.lines)}
        <span className="chip-chevron">{open ? '▾' : '▸'}</span>
      </button>
      <button className="chip-remove" onClick={onRemove} title={t('composer.chip.remove')}>
        ×
      </button>
      {open && (
        <textarea
          className="chip-editor"
          value={item.text}
          onChange={(event) => onEdit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setOpen(false);
            onDoneEditing();
          }}
          aria-label={t('composer.chip.editorLabel', { number: item.number })}
          spellCheck={false}
          autoFocus
        />
      )}
    </div>
  );
}
