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
  MAX_SUBMIT_IMAGE_BYTES,
  type Note,
  type ServerMessage,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

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

        case 'error':
          if (message.code === 'notes-failed') setProblem(message.message);
          break;

        default:
          break;
      }
    });
    // Tras una reconexion el servidor vuelve a mandar la lista con el hello;
    // lo que se olvida es que imagenes ya se pidieron, por si alguna se perdio.
    const offReopen = connection.onReopen(() => {
      requested.current.clear();
    });
    return () => {
      offMessage();
      offReopen();
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
        setProblem(`Hasta ${MAX_NOTE_IMAGES} imagenes por nota.`);
        return;
      }
      if (file.size > MAX_SUBMIT_IMAGE_BYTES) {
        setProblem(
          `"${file.name || 'la imagen'}" pesa ${Math.round(file.size / 1024 / 1024)} MB; el maximo son ${
            MAX_SUBMIT_IMAGE_BYTES / 1024 / 1024
          } MB.`,
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
      reader.onerror = () => setProblem('No se pudo leer la imagen.');
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
    sendToAgent,
    dismissProblem,
  };
}
