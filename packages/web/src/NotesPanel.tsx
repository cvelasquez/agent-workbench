/**
 * Notas sueltas, al pie de la barra lateral.
 *
 * Ideas que se anotan mientras se trabaja: no son de ningun proyecto ni de
 * ninguna pestana, y por eso viven abajo de la lista de proyectos y no en el
 * panel derecho, que es de la pestana activa. Se pliegan a una fila cuando no
 * se usan, y abiertas se llevan un alto que se arrastra desde su borde.
 *
 * Sus solapas son las mismas que las de la consola del panel derecho —la
 * familia `.strip-tab*`— y se pliega igual que ella: el `+` al lado de la
 * ultima solapa, un `▾` a la derecha, y plegada una fila que dice cuantas hay.
 * Eran dos cosas identicas en intencion y distintas en todo lo demas.
 *
 * Cada nota es una solapa. **Cerrar borra** —es lo que pidio el usuario: duran
 * hasta que el las cierra— y como es la unica accion destructiva de la app, una
 * nota con algo escrito pide confirmar en el mismo lugar. Sin `confirm()` del
 * navegador: un dialogo modal bloquea la pagina entera, y la automatizacion
 * con ella.
 *
 * Las imagenes entran por pegado, arrastre o el boton, y viajan por referencia:
 * la miniatura pide el contenido cuando se dibuja.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { noteTitle, type Note, type NoteImage } from '@agent-workbench/shared';
import { formatWhen } from './format-when.js';
import type { NotesApi } from './useNotes.js';

const OPEN_KEY = 'agent-workbench.notes-open';
const ACTIVE_KEY = 'agent-workbench.notes-active';
const HEIGHT_KEY = 'agent-workbench.notes-height';

const MIN_HEIGHT = 160;
const DEFAULT_HEIGHT = 300;

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sin persistencia se sigue igual: es una preferencia, no un dato.
  }
}

interface NotesPanelProps {
  notes: NotesApi;
  /**
   * Abre una conversacion nueva con la nota adentro, en el proyecto de la
   * pestana activa. null cuando no hay ninguna: sin `cwd` no hay donde abrirla.
   */
  onSendNote: ((noteId: string) => void) | null;
  /** El `cwd` de esa pestana, para el titulo del boton. */
  sendTargetCwd: string | null;
}

export function NotesPanel({
  notes,
  onSendNote,
  sendTargetCwd,
}: NotesPanelProps): JSX.Element {
  const [open, setOpen] = useState(() => readStored(OPEN_KEY) === 'true');
  const [height, setHeight] = useState(() => {
    const parsed = Number.parseInt(readStored(HEIGHT_KEY) ?? '', 10);
    return Number.isFinite(parsed) ? Math.max(parsed, MIN_HEIGHT) : DEFAULT_HEIGHT;
  });
  const [storedActive, setStoredActive] = useState<string | null>(() => readStored(ACTIVE_KEY));
  const [closing, setClosing] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  /*
    La solapa activa se resuelve contra la lista, no se guarda como verdad: si
    la nota se cerro desde otra ventana, o el id guardado ya no existe, se cae a
    la ultima. Nunca una solapa activa que no se puede ver.
  */
  const active = useMemo(() => {
    if (notes.notes.length === 0) return null;
    return (
      notes.notes.find((note) => note.noteId === storedActive) ??
      notes.notes[notes.notes.length - 1] ??
      null
    );
  }, [notes.notes, storedActive]);

  const selectNote = useCallback((noteId: string) => {
    setStoredActive(noteId);
    writeStored(ACTIVE_KEY, noteId);
    setClosing(null);
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      writeStored(OPEN_KEY, String(next));
      return next;
    });
  }, []);

  const createNote = useCallback(() => {
    const noteId = notes.create();
    selectNote(noteId);
    if (!open) {
      setOpen(true);
      writeStored(OPEN_KEY, 'true');
    }
    setFocusRequest((value) => value + 1);
  }, [notes, open, selectNote]);

  /** Una nota vacia se cierra sin preguntar: no hay nada que perder. */
  const requestClose = useCallback(
    (note: Note) => {
      if (note.text.trim().length === 0 && note.images.length === 0) {
        notes.remove(note.noteId);
        return;
      }
      selectNote(note.noteId);
      setClosing(note.noteId);
    },
    [notes, selectNote],
  );

  const confirmClose = useCallback(() => {
    if (closing !== null) notes.remove(closing);
    setClosing(null);
  }, [closing, notes]);

  // ---- alto arrastrable, desde el borde superior ----
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = { startY: event.clientY, startHeight: height };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [height],
  );

  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.8));
    setHeight(Math.min(max, Math.max(MIN_HEIGHT, drag.startHeight + drag.startY - event.clientY)));
  }, []);

  const onResizePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      writeStored(HEIGHT_KEY, String(height));
    },
    [height],
  );

  // El visor grande se cierra con Esc, ademas del clic.
  useEffect(() => {
    if (lightbox === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setLightbox(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [lightbox]);

  const lightboxSrc = lightbox === null ? undefined : notes.images[lightbox];
  const count = notes.notes.length;

  return (
    <section
      className={`notes${open ? ' notes-open' : ''}`}
      style={open ? { height: `${height}px` } : undefined}
    >
      {open && (
        <div
          className="notes-resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          title="Arrastrar para cambiar el alto"
        />
      )}

      {/*
        Plegada es una fila entera que dice que hay algo aca, igual que la
        consola del pie de la columna derecha: `.strip-collapsed`. Antes era la
        misma cabecera de siempre con un chevron, y el `+` vivia ahi arriba en
        vez de al lado de la ultima solapa.
      */}
      {!open ? (
        <button
          className="strip-collapsed"
          onClick={toggleOpen}
          title="Desplegar las notas"
        >
          <span className="strip-collapsed-arrow">▸</span>
          <span>Notas</span>
          {count > 0 && <span className="strip-collapsed-count">{count}</span>}
        </button>
      ) : (
        <>
          <div className="notes-header">
            <div className="strip-tabs" role="tablist">
              {notes.notes.map((note) => {
                const isActive = note.noteId === active?.noteId;
                const title = noteTitle(note);
                return (
                  <div
                    key={note.noteId}
                    className={`strip-tab${isActive ? ' is-active' : ''}`}
                    role="tab"
                    aria-selected={isActive}
                  >
                    <button
                      className="strip-tab-label"
                      onClick={() => selectNote(note.noteId)}
                      title={title}
                    >
                      {title}
                    </button>
                    <button
                      className="strip-tab-close"
                      onClick={() => requestClose(note)}
                      title="Cerrar la nota. Se borra, con sus imagenes"
                    >
                      ×
                    </button>
                  </div>
                );
              })}

              <button className="strip-tab-new" onClick={createNote} title="Nueva nota">
                +
              </button>
            </div>

            <span className="strip-spacer" />
            <button
              className="icon-button"
              onClick={toggleOpen}
              title="Plegar. Las notas no se pierden: cerrarlas es la × de cada solapa"
            >
              ▾
            </button>
          </div>

          <div className="notes-body">
            {count === 0 || active === null ? (
              <p className="notes-empty">
                Sin notas. El <b>+</b> abre una; sirven para anotar una idea sin salir de lo
                que estas haciendo.
              </p>
            ) : (
              <NoteEditor
                key={active.noteId}
                note={active}
                notes={notes}
                closing={closing === active.noteId}
                focusRequest={focusRequest}
                onConfirmClose={confirmClose}
                onCancelClose={() => setClosing(null)}
                onOpenImage={setLightbox}
                onSend={onSendNote === null ? null : () => onSendNote(active.noteId)}
                sendTargetCwd={sendTargetCwd}
              />
            )}
          </div>
        </>
      )}

      {lightbox !== null && (
        <div className="notes-lightbox" onClick={() => setLightbox(null)} title="Clic para cerrar">
          {typeof lightboxSrc === 'string' ? (
            <img src={lightboxSrc} alt="imagen de la nota" />
          ) : (
            <span className="notes-lightbox-missing">la imagen no esta disponible</span>
          )}
        </div>
      )}
    </section>
  );
}

interface NoteEditorProps {
  note: Note;
  notes: NotesApi;
  closing: boolean;
  focusRequest: number;
  onConfirmClose: () => void;
  onCancelClose: () => void;
  onOpenImage: (imageId: string) => void;
  /** Manda la nota al agente en una conversacion nueva, o null si no se puede. */
  onSend: (() => void) | null;
  /** Donde se abriria esa conversacion. Para el titulo del boton. */
  sendTargetCwd: string | null;
}

/**
 * El clip de adjuntar, dibujado a mano.
 *
 * SVG inline y no una fuente de iconos, por lo mismo que la caja de archivar de
 * la barra lateral: un paquete entero son cientos de KB para un glifo, y
 * traerlo de un CDN seria una llamada de red saliente, que esta app no hace
 * (CLAUDE.md 2.4).
 */
function ClipIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11.5 11.7 19.8a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.9-7.9" />
    </svg>
  );
}

/**
 * El avion de papel de "mandar al agente".
 *
 * SVG inline por lo mismo que el clip de al lado: un paquete de iconos entero
 * son cientos de KB para un glifo, y traerlo de un CDN seria una llamada de red
 * saliente, que esta app no hace (CLAUDE.md 2.4).
 */
function SendIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.5 2.5 11 13" />
      <path d="M21.5 2.5 15 21.5l-4-8.5-8.5-4z" />
    </svg>
  );
}

function NoteEditor({
  note,
  notes,
  closing,
  focusRequest,
  onConfirmClose,
  onCancelClose,
  onOpenImage,
  onSend,
  sendTargetCwd,
}: NoteEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const empty = note.text.trim().length === 0 && note.images.length === 0;

  // Solo se roba el foco al crear una nota: es lo que el usuario acaba de pedir.
  useEffect(() => {
    if (focusRequest > 0) textareaRef.current?.focus();
  }, [focusRequest]);

  const acceptFiles = useCallback(
    (files: FileList | File[]): boolean => {
      const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
      for (const file of images) notes.addImage(note.noteId, file);
      return images.length > 0;
    },
    [notes, note.noteId],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (event.clipboardData === null) return;
      // Solo se intercepta una imagen. El texto lo pega el navegador, con su
      // deshacer y su cursor.
      if (acceptFiles(event.clipboardData.files)) event.preventDefault();
    },
    [acceptFiles],
  );

  return (
    <div
      className={`note-editor${dragging ? ' note-editor-dragging' : ''}`}
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
        acceptFiles(event.dataTransfer.files);
      }}
    >
      {closing && (
        <div className="note-closing">
          <span>Cerrar esta nota la borra, con sus imagenes.</span>
          <button className="link-button link-danger" onClick={onConfirmClose}>
            Cerrar
          </button>
          <button className="link-button" onClick={onCancelClose}>
            Cancelar
          </button>
        </div>
      )}

      {notes.problem !== null && (
        <div className="composer-problem">
          <span>{notes.problem}</span>
          <button className="icon-button" onClick={notes.dismissProblem} title="Cerrar">
            ×
          </button>
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="note-input"
        value={note.text}
        placeholder="Anota una idea. Las imagenes se pegan o se arrastran aca."
        onChange={(event) => notes.updateText(note.noteId, event.target.value)}
        onPaste={onPaste}
        spellCheck={false}
      />

      {note.images.length > 0 && (
        <div className="note-images">
          {note.images.map((image) => (
            <NoteThumb
              key={image.imageId}
              image={image}
              src={notes.images[image.imageId]}
              onRequest={notes.requestImage}
              onOpen={() => onOpenImage(image.imageId)}
              onRemove={() => notes.removeImage(note.noteId, image.imageId)}
            />
          ))}
        </div>
      )}

      <div className="note-footer">
        <span className="note-meta">{formatWhen(note.updatedAt)}</span>
        <span className="composer-spacer" />
        {/*
          Mandar la nota al agente, en una conversacion nueva del proyecto que
          se este mirando. **No la borra**: cerrar es lo unico que borra, y por
          eso confirma. Apagado sin pestana activa, porque sin `cwd` no hay
          donde abrirla, y el titulo dice por que.
        */}
        <button
          className="icon-button"
          onClick={() => onSend?.()}
          disabled={onSend === null || empty}
          title={
            onSend === null
              ? 'Abri una pestana primero: la conversacion se abre en su proyecto'
              : empty
                ? 'La nota esta vacia'
                : `Mandar la nota al agente en una conversacion nueva de ${sendTargetCwd ?? ''}`
          }
        >
          <SendIcon />
        </button>
        <label className="icon-button note-attach" title="Adjuntar una imagen desde un archivo">
          <ClipIcon />
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files !== null) acceptFiles(event.target.files);
              // Que elegir el mismo archivo dos veces vuelva a disparar el cambio.
              event.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}

interface NoteThumbProps {
  image: NoteImage;
  src: string | null | undefined;
  onRequest: (imageId: string) => void;
  onOpen: () => void;
  onRemove: () => void;
}

function NoteThumb({ image, src, onRequest, onOpen, onRemove }: NoteThumbProps): JSX.Element {
  useEffect(() => {
    if (src === undefined) onRequest(image.imageId);
  }, [src, image.imageId, onRequest]);

  return (
    <figure className="chip chip-image note-thumb" title={formatBytes(image.bytes)}>
      {typeof src === 'string' ? (
        <img src={src} alt="imagen de la nota" onClick={onOpen} />
      ) : (
        <span className="note-thumb-placeholder">{src === null ? 'no esta' : '…'}</span>
      )}
      <button className="chip-remove" onClick={onRemove} title="Quitar la imagen">
        ×
      </button>
    </figure>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
