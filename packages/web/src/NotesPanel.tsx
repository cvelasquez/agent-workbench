/**
 * Notas sueltas: la ultima solapa del panel derecho.
 *
 * Ideas que se anotan mientras se trabaja: no son de ningun proyecto ni de
 * ninguna pestana. Hasta el hito 36 vivian al pie de la barra de proyectos; del
 * 36 al 12-11-2026, al pie de la columna derecha, plegables y con un alto que se
 * arrastraba. Abiertas junto a la consola le dejaban a la CLI pocas filas (8 en
 * una ventana de 900 px), y Codex recorta sus menus con una terminal baja. Ahora
 * son una solapa del panel (`SidePanel`) y se turnan con la CLI, sin alto propio
 * ni plegado. Llenan el hueco que les toca: la solapa, la columna entera cuando
 * no hay ninguna pestana abierta (no hay panel) o la vista de notas del telefono.
 *
 * Sus solapas son las mismas que las de la consola del panel derecho (la
 * familia `.strip-tab*`), con el `+` al lado de la ultima solapa.
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
import { noteSendTitle, noteToComposerTitle } from './agent-ui.js';
import { formatBytes, formatWhen } from './i18n/format.js';
import { t } from './i18n/index.js';
import { tRich } from './i18n/rich.js';
import { continueList } from './list-continuation.js';
import { noteImagesReady } from './note-to-composer.js';
import { SectionHideButton } from './SectionHideButton.js';
import { threadFontTitle } from './thread-font.js';
import type { NotesApi } from './useNotes.js';
import { useNotesFont } from './useThreadFont.js';
import { readStored, writeStored } from './window-prefs.js';

const ACTIVE_KEY = 'agent-workbench.notes-active';

/**
 * El titulo de la solapa. Los respaldos de `noteTitle` ("Nota", "Imagen")
 * vienen en espanol de `shared`: los de una nota sin texto salen de aca, en el
 * idioma de la app.
 */
function tabTitle(note: Note): string {
  if (note.text.trim().length === 0) {
    return (note.files?.length ?? 0) > 0 ? note.files?.[0]?.name ?? t('notes.fileOnly')
      : note.images.length > 0 ? t('notes.imageOnly') : t('notes.untitled');
  }
  return noteTitle(note);
}

interface NotesPanelProps {
  notes: NotesApi;
  /**
   * Abre una conversacion nueva con la nota adentro, en el proyecto de la
   * pestana activa. null cuando no hay ninguna —sin `cwd` no hay donde
   * abrirla— o cuando su CLI no avisa que esta lista para recibirla.
   */
  onSendNote: ((noteId: string) => void) | null;
  /**
   * El `cwd` de esa pestana, para el titulo del boton. Con `onSendNote` null,
   * es lo que distingue "no hay pestana" de "esta CLI no puede".
   */
  sendTargetCwd: string | null;
  /**
   * "Al cuadro" (hito 50, §6.6.2): la nota al cuadro de la pestana activa, a la
   * conversacion que ya existe. null sin pestana.
   */
  onNoteToComposer: ((noteId: string) => void | Promise<void>) | null;
  /** El nombre de esa pestana, para el titulo del boton. */
  composerTarget: string | null;
  /**
   * Esconde las notas (Hito 41) hasta mostrarlas desde Ajustes. No borra ninguna.
   * Solo cuando son lo unico de la columna, sin ninguna pestana abierta: como
   * solapa se esconden desde Ajustes, igual que las demas. Ausente en la solapa
   * y en la vista angosta.
   */
  onHide?: () => void;
}

export function NotesPanel({
  notes,
  onSendNote,
  sendTargetCwd,
  onNoteToComposer,
  composerTarget,
  onHide,
}: NotesPanelProps): JSX.Element {
  const [storedActive, setStoredActive] = useState<string | null>(() =>
    readStored<string | null>(ACTIVE_KEY, null, (raw) => raw),
  );
  const [closing, setClosing] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const notesFont = useNotesFont();

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

  const createNote = useCallback(() => {
    const noteId = notes.create();
    selectNote(noteId);
    setFocusRequest((value) => value + 1);
  }, [notes, selectNote]);

  /** Una nota vacia se cierra sin preguntar: no hay nada que perder. */
  const requestClose = useCallback(
    (note: Note) => {
      if (note.text.trim().length === 0 && note.images.length === 0 && (note.files?.length ?? 0) === 0) {
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
    <section className="notes">
      <div className="notes-header">
        <div className="strip-tabs" role="tablist">
          {notes.notes.map((note) => {
            const isActive = note.noteId === active?.noteId;
            const title = tabTitle(note);
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
                  title={t('notes.closeNote')}
                >
                  ×
                </button>
              </div>
            );
          })}

          <button className="strip-tab-new" onClick={createNote} title={t('notes.new')}>
            +
          </button>
        </div>

        <span className="strip-spacer" />
        {/*
          El mismo boton y los mismos tres tamanos que el hilo (§6.22), con
          su propia preferencia. Pedido para el telefono, donde 12,5 px se
          leen mal; vale igual en la PC.
        */}
        <button
          className="icon-button thread-font-button"
          onClick={notesFont.cycle}
          title={threadFontTitle(notesFont.size)}
          aria-label={threadFontTitle(notesFont.size)}
        >
          <span aria-hidden="true">
            a<span className="thread-font-big">A</span>
          </span>
        </button>
        {onHide !== undefined && <SectionHideButton title={t('settings.hide.notes')} onHide={onHide} confirmText={null} />}
      </div>

      <div className="notes-body">
        {count === 0 || active === null ? (
          <p className="notes-empty">{tRich('notes.empty')}</p>
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
            onToComposer={onNoteToComposer === null ? null : () => onNoteToComposer(active.noteId)}
            composerTarget={composerTarget}
          />
        )}
      </div>

      {lightbox !== null && (
        <div className="notes-lightbox" onClick={() => setLightbox(null)} title={t('notes.lightboxClose')}>
          {typeof lightboxSrc === 'string' ? (
            <img src={lightboxSrc} alt={t('notes.imageAlt')} />
          ) : (
            <span className="notes-lightbox-missing">{t('notes.imageUnavailable')}</span>
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
  /** La pone en el cuadro de la pestana activa (hito 50), o null sin pestana. */
  onToComposer: (() => void | Promise<void>) | null;
  composerTarget: string | null;
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
  onToComposer,
  composerTarget,
}: NoteEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const empty = note.text.trim().length === 0 && note.images.length === 0 && (note.files?.length ?? 0) === 0;
  const imagesReady = noteImagesReady(note.images, notes.images);

  // Solo se roba el foco al crear una nota: es lo que el usuario acaba de pedir.
  useEffect(() => {
    if (focusRequest > 0) textareaRef.current?.focus();
  }, [focusRequest]);

  const acceptFiles = useCallback(
    (files: FileList | File[]): boolean => {
      for (const file of Array.from(files)) {
        if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) notes.addImage(note.noteId, file);
        else notes.addFile(note.noteId, file);
      }
      return files.length > 0;
    },
    [notes, note.noteId],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (event.clipboardData === null) return;
      // Solo se interceptan archivos. El texto lo pega el navegador, con su
      // deshacer y su cursor.
      if (acceptFiles(event.clipboardData.files)) event.preventDefault();
    },
    [acceptFiles],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || !event.shiftKey || event.nativeEvent.isComposing) return;
      const element = event.currentTarget;
      const change = continueList(element.value, element.selectionStart, element.selectionEnd);
      if (change === null) return;
      event.preventDefault();
      // Como en el prompt: una edicion nativa conserva deshacer y dispara onChange.
      element.setSelectionRange(change.from, change.to);
      let done = false;
      try {
        done = change.text.length > 0
          ? document.execCommand('insertText', false, change.text)
          : document.execCommand('delete');
      } catch {
        done = false;
      }
      if (!done) {
        element.setRangeText(change.text, change.from, change.to, 'end');
        notes.updateText(note.noteId, element.value);
      }
      element.setSelectionRange(change.caret, change.caret);
    },
    [notes, note.noteId],
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
          <span>{t('notes.closeConfirm')}</span>
          <button className="link-button link-danger" onClick={onConfirmClose}>
            {t('common.close')}
          </button>
          <button className="link-button" onClick={onCancelClose}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {notes.problem !== null && (
        <div className="composer-problem">
          <span>{notes.problem}</span>
          <button className="icon-button" onClick={notes.dismissProblem} title={t('common.close')}>
            ×
          </button>
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="note-input"
        value={note.text}
        placeholder={t('notes.placeholder')}
        onChange={(event) => notes.updateText(note.noteId, event.target.value)}
        onKeyDown={onKeyDown}
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

      {(note.files?.length ?? 0) > 0 && (
        <div className="note-images">
          {(note.files ?? []).map((file) => (
            <div className="chip chip-text chip-file" key={file.fileId} title={`${file.name} · ${formatBytes(file.bytes)}`}>
              <a
                className="chip-toggle chip-file-label"
                title={t('notes.downloadFile')}
                href={`/api/notes/files/${encodeURIComponent(file.fileId)}?name=${encodeURIComponent(file.name)}`}
                download={file.name}
              >
                <span aria-hidden="true">↓</span>
                <span className="chip-file-name">{file.name}</span>
                <span className="chip-file-size">{formatBytes(file.bytes)}</span>
              </a>
              <button className="chip-remove" onClick={() => notes.removeFile(note.noteId, file.fileId)} title={t('notes.removeFile')}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className="note-footer">
        <span className="note-meta">{formatWhen(note.updatedAt)}</span>
        <span className="composer-spacer" />
        {/*
          "Al cuadro" (hito 50, §6.6.2): la nota al cuadro de la pestana activa,
          a la conversacion que ya existe; el avion de al lado abre una nueva.
          Espera a que el navegador tenga las imagenes: las miniaturas las piden
          al dibujarse. Tampoco borra la nota.
        */}
        <button
          className="link-button note-to-composer"
          onClick={() => {
            setLoading(true);
            void Promise.resolve(onToComposer?.()).finally(() => setLoading(false));
          }}
          disabled={onToComposer === null || empty || !imagesReady || loading}
          title={noteToComposerTitle(onToComposer === null ? null : composerTarget ?? '', empty, imagesReady)}
        >
          {loading ? t('notes.loadingFiles') : t('notes.toComposer')}
        </button>
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
          title={noteSendTitle(onSend !== null, sendTargetCwd, empty)}
        >
          <SendIcon />
        </button>
        <label className="icon-button note-attach" title={t('notes.attach')}>
          <ClipIcon />
          <input
            type="file"
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
        <img src={src} alt={t('notes.imageAlt')} onClick={onOpen} />
      ) : (
        <span className="note-thumb-placeholder">{src === null ? t('notes.thumbMissing') : '…'}</span>
      )}
      <button className="chip-remove" onClick={onRemove} title={t('notes.removeImage')}>
        ×
      </button>
    </figure>
  );
}
