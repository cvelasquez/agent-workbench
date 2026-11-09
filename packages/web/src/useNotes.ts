/**
 * Notas sueltas: estado del lado del navegador.
 *
 * La lista la manda el servidor —al conectar y tras cada cambio— salvo por el
 * texto que uno mismo teclea: ese se aplica aca al instante y viaja tecla a
 * tecla, y el servidor **no** lo devuelve a quien lo escribio. Sin eso, el eco
 * de cada tecla pisaria lo escrito entre el envio y la respuesta.
 *
 * Las imagenes viven aparte, por id, igual que las del historial: la lista
 * lleva referencias y el contenido se pide cuando la miniatura se dibuja.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_NOTE_IMAGES,
  MAX_NOTE_FILES,
  MAX_SUBMIT_FILES,
  MAX_SUBMIT_FILE_BYTES,
  MAX_SUBMIT_IMAGE_BYTES,
  type Note,
  type ServerMessage,
  type SubmitFile,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';

export interface NotesApi {
  notes: Note[];
  /**
   * `imageId` -> data URL. Ausente: no se pidio todavia. `null`: el servidor
   * no la encontro. Distinguirlos evita pedir en bucle una que no aparece.
   */
  images: Record<string, string | null>;
  /** El ultimo problema al agregar una imagen, o null. */
  problem: string | null;
  requestImage: (imageId: string) => void;
  /** Crea una nota y devuelve su id, para activar la solapa sin esperar. */
  create: () => string;
  updateText: (noteId: string, text: string) => void;
  /** Cerrar es borrar, con sus imagenes. Quien llama confirma antes. */
  remove: (noteId: string) => void;
  addImage: (noteId: string, file: File) => void;
  removeImage: (noteId: string, imageId: string) => void;
  addFile: (noteId: string, file: File) => void;
  removeFile: (noteId: string, fileId: string) => void;
  requestFile: (fileId: string) => Promise<SubmitFile | null>;
  filesForComposer: (note: Note) => Promise<SubmitFile[] | null>;
  /**
   * Manda la nota entera al agente de una pestana, con sus imagenes.
   *
   * Viajan solo los dos ids: el contenido ya esta en el servidor. La nota no
   * se borra — mandarla no es cerrarla.
   */
  sendToAgent: (noteId: string, terminalId: string) => void;
  dismissProblem: () => void;
}

export function useNotes(connection: AgentConnection): NotesApi {
  const [notes, setNotes] = useState<Note[]>([]);
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const requested = useRef(new Set<string>());
  const pendingFiles = useRef(new Map<string, (file: SubmitFile | null) => void>());

  useEffect(() => {
    const offMessage = connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'notes.list':
          setNotes(message.notes);
          break;

        case 'notes.imageData':
          requested.current.add(message.imageId);
          setImages((current) => ({
            ...current,
            [message.imageId]:
              message.data === null ? null : `data:${message.mediaType};base64,${message.data}`,
          }));
          break;

        case 'notes.fileData':
          // Un acuse de subida no es una lectura ni debe conservar sus bytes.
          pendingFiles.current.get(message.fileId)?.(
            message.data === null ? null : { name: message.name, data: message.data },
          );
          break;

        case 'error':
          if (message.code === 'notes-failed') setProblem(serverTextMessage(message.text));
          break;

        default:
          break;
      }
    });
    // Tras una reconexion el servidor vuelve a mandar la lista con el hello;
    // lo que se olvida es que imagenes ya se pidieron, por si alguna se perdio.
    const offReopen = connection.onReopen(() => {
      requested.current.clear();
      for (const resolve of pendingFiles.current.values()) resolve(null);
    });
    return () => {
      offMessage();
      offReopen();
      for (const resolve of pendingFiles.current.values()) resolve(null);
    };
  }, [connection]);

  const requestImage = useCallback(
    (imageId: string) => {
      if (requested.current.has(imageId)) return;
      requested.current.add(imageId);
      connection.send({ type: 'notes.image', imageId });
    },
    [connection],
  );

  const create = useCallback((): string => {
    const noteId = crypto.randomUUID();
    const now = Date.now();
    // Se dibuja ya: esperar la lista del servidor para ver la solapa nueva
    // seria un parpadeo entre el clic y la nota.
    setNotes((current) => [
      ...current,
      { noteId, text: '', images: [], createdAt: now, updatedAt: now },
    ]);
    connection.send({ type: 'notes.create', noteId });
    return noteId;
  }, [connection]);

  const updateText = useCallback(
    (noteId: string, text: string) => {
      setNotes((current) =>
        current.map((note) =>
          note.noteId === noteId ? { ...note, text, updatedAt: Date.now() } : note,
        ),
      );
      connection.send({ type: 'notes.update', noteId, text });
    },
    [connection],
  );

  const remove = useCallback(
    (noteId: string) => {
      setNotes((current) => current.filter((note) => note.noteId !== noteId));
      connection.send({ type: 'notes.delete', noteId });
    },
    [connection],
  );

  const addImage = useCallback(
    (noteId: string, file: File) => {
      const note = notes.find((entry) => entry.noteId === noteId);
      if (note !== undefined && note.images.length >= MAX_NOTE_IMAGES) {
        setProblem(t('notes.tooManyImages', { count: MAX_NOTE_IMAGES }));
        return;
      }
      if (file.size > MAX_SUBMIT_IMAGE_BYTES) {
        setProblem(
          t('notes.imageTooBig', {
            name: file.name || t('notes.imageFallbackName'),
            size: Math.round(file.size / 1024 / 1024),
            max: MAX_SUBMIT_IMAGE_BYTES / 1024 / 1024,
          }),
        );
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') return;
        const comma = result.indexOf(',');
        if (comma === -1) return;
        connection.send({
          type: 'notes.addImage',
          noteId,
          image: { mediaType: file.type, data: result.slice(comma + 1) },
        });
      };
      reader.onerror = () => setProblem(t('notes.readFailed'));
      reader.readAsDataURL(file);
    },
    [connection, notes],
  );

  const removeImage = useCallback(
    (noteId: string, imageId: string) => {
      setNotes((current) =>
        current.map((note) =>
          note.noteId === noteId
            ? { ...note, images: note.images.filter((image) => image.imageId !== imageId) }
            : note,
        ),
      );
      connection.send({ type: 'notes.removeImage', noteId, imageId });
    },
    [connection],
  );

  const sendToAgent = useCallback(
    (noteId: string, terminalId: string) => {
      connection.send({ type: 'notes.send', noteId, terminalId });
    },
    [connection],
  );

  const addFile = useCallback((noteId: string, file: File) => {
    const note = notes.find((entry) => entry.noteId === noteId);
    if ((note?.files?.length ?? 0) >= MAX_NOTE_FILES) {
      setProblem(t('notes.tooManyFiles', { max: MAX_NOTE_FILES }));
      return;
    }
    if (file.size === 0) {
      setProblem(t('composer.problem.empty', { name: file.name }));
      return;
    }
    if (file.size > MAX_SUBMIT_FILE_BYTES) {
      setProblem(t('composer.problem.tooBig', {
        name: file.name, size: Math.round(file.size / 1024 / 1024), max: MAX_SUBMIT_FILE_BYTES / 1024 / 1024,
      }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      const comma = reader.result.indexOf(',');
      if (comma < 0) return;
      connection.send({ type: 'notes.addFile', noteId, file: { name: file.name, data: reader.result.slice(comma + 1) } });
    };
    reader.onerror = () => setProblem(t('composer.problem.unreadable', { name: file.name }));
    reader.readAsDataURL(file);
  }, [connection, notes]);

  const removeFile = useCallback((noteId: string, fileId: string) => {
    setNotes((current) => current.map((note) => note.noteId === noteId
      ? { ...note, files: (note.files ?? []).filter((file) => file.fileId !== fileId) } : note));
    connection.send({ type: 'notes.removeFile', noteId, fileId });
  }, [connection]);

  const requestFile = useCallback((fileId: string): Promise<SubmitFile | null> => {
    // Una sola lectura por id. Los archivos no se cargan al abrir una nota.
    if (pendingFiles.current.has(fileId)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (file: SubmitFile | null): void => {
        clearTimeout(timeout);
        pendingFiles.current.delete(fileId);
        if (file === null) setProblem(t('notes.fileUnavailable'));
        resolve(file);
      };
      const timeout = setTimeout(() => finish(null), 60_000);
      pendingFiles.current.set(fileId, finish);
      connection.send({ type: 'notes.file', fileId });
    });
  }, [connection]);

  const filesForComposer = useCallback(async (note: Note): Promise<SubmitFile[] | null> => {
    if ((note.files?.length ?? 0) > MAX_SUBMIT_FILES) {
      setProblem(t('composer.problem.tooManyFiles', { count: MAX_SUBMIT_FILES }));
      return null;
    }
    const files: SubmitFile[] = [];
    for (const entry of note.files ?? []) {
      const file = await requestFile(entry.fileId);
      if (file === null) return null;
      files.push(file);
    }
    return files;
  }, [requestFile]);

  const dismissProblem = useCallback(() => setProblem(null), []);

  return {
    notes,
    images,
    problem,
    requestImage,
    create,
    updateText,
    remove,
    addImage,
    removeImage,
    addFile,
    removeFile,
    requestFile,
    filesForComposer,
    sendToAgent,
    dismissProblem,
  };
}
