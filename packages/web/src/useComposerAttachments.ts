/**
 * Lo que se pega en el cuadro de escritura y no es texto corto.
 *
 * Dos casos, y los dos por el mismo motivo — que el cuadro siga siendo legible
 * despues de pegar:
 *
 *  - **Una imagen** se queda como miniatura. El navegador ya la tiene en el
 *    portapapeles como archivo; aca se convierte a base64 para poder mandarla
 *    por el socket, y el servidor la escribe en disco antes de nombrarsela a la
 *    CLI.
 *  - **Un texto de mas de cuatro lineas** se pliega en una ficha desplegable.
 *    Pegar un stack trace de 300 lineas dentro de un textarea entierra el
 *    pedido que uno estaba escribiendo.
 *
 * Lo demas —un texto corto— no se toca: lo pega el navegador como siempre. Un
 * pegado que se comporta distinto de lo esperado es peor que uno lento.
 */

import { useCallback, useState } from 'react';
import { MAX_SUBMIT_IMAGES, MAX_SUBMIT_IMAGE_BYTES } from '@agent-workbench/shared';
import { IMAGES_REFUSED_MESSAGE } from './agent-ui.js';

/** A partir de cuantas lineas el texto pegado se pliega. */
const FOLD_FROM_LINES = 5;

/**
 * ...y a partir de cuantos caracteres, aunque venga en una sola linea.
 *
 * Un JSON minificado de 40 KB es una linea sola y hunde el cuadro igual.
 */
const FOLD_FROM_CHARS = 1_200;

export type Attachment =
  | {
      id: string;
      kind: 'image';
      mediaType: string;
      /** Sin el prefijo `data:`; es lo que viaja por el socket. */
      base64: string;
      /** Con el prefijo; es lo que se pinta en la miniatura. */
      dataUrl: string;
      bytes: number;
      name: string;
    }
  | {
      id: string;
      kind: 'text';
      text: string;
      lines: number;
    };

export interface ComposerAttachments {
  items: Attachment[];
  /** El ultimo problema al pegar (imagen enorme, formato raro), o null. */
  problem: string | null;
  /** true si el evento se consumio: quien llama debe hacer preventDefault. */
  acceptPaste: (data: DataTransfer) => boolean;
  /** Para arrastrar y soltar. Solo mira imagenes. */
  acceptFiles: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  /**
   * Cambia los adjuntos de golpe.
   *
   * Existe para el borrador por pestana del cuadro de escritura: al volver a
   * una conversacion hay que devolverle lo que tenia pegado, no vaciarla.
   */
  replace: (next: Attachment[]) => void;
  clear: () => void;
  dismissProblem: () => void;
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * @param imagesAllowed false si la CLI de la pestana no recibe imagenes por
 *   ruta. Ahi pegar o soltar una imagen avisa y no la agrega: una miniatura que
 *   el servidor va a rechazar al enviar es peor que decirlo en el momento.
 */
export function useComposerAttachments(imagesAllowed = true): ComposerAttachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const addImage = useCallback((file: File) => {
    if (items.filter((item) => item.kind === 'image').length >= MAX_SUBMIT_IMAGES) {
      setProblem(`Hasta ${MAX_SUBMIT_IMAGES} imagenes por mensaje.`);
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
      setItems((current) =>
        current.filter((item) => item.kind === 'image').length >= MAX_SUBMIT_IMAGES
          ? current
          : [
              ...current,
              {
                id: newId(),
                kind: 'image',
                mediaType: file.type,
                base64: result.slice(comma + 1),
                dataUrl: result,
                bytes: file.size,
                name: file.name.length > 0 ? file.name : 'imagen pegada',
              },
            ],
      );
    };
    reader.onerror = () => setProblem('No se pudo leer la imagen del portapapeles.');
    reader.readAsDataURL(file);
  }, [items]);

  const acceptFiles = useCallback(
    (files: FileList | File[]) => {
      const images = Array.from(files).filter((file) => file.type.startsWith('image/'));
      if (images.length > 0 && !imagesAllowed) {
        setProblem(IMAGES_REFUSED_MESSAGE);
        return;
      }
      for (const file of images) addImage(file);
    },
    [addImage, imagesAllowed],
  );

  const acceptPaste = useCallback(
    (data: DataTransfer): boolean => {
      const images = Array.from(data.files).filter((file) => file.type.startsWith('image/'));
      if (images.length > 0) {
        if (!imagesAllowed) {
          setProblem(IMAGES_REFUSED_MESSAGE);
          return true;
        }
        for (const file of images) addImage(file);
        return true;
      }

      const text = data.getData('text/plain');
      if (text.length === 0) return false;

      const lines = text.split('\n').length;
      if (lines < FOLD_FROM_LINES && text.length < FOLD_FROM_CHARS) return false;

      setItems((current) => [...current, { id: newId(), kind: 'text', text, lines }]);
      return true;
    },
    [addImage, imagesAllowed],
  );

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const replace = useCallback((next: Attachment[]) => {
    setItems(next);
    setProblem(null);
  }, []);

  const clear = useCallback(() => replace([]), [replace]);

  const dismissProblem = useCallback(() => setProblem(null), []);

  return { items, problem, acceptPaste, acceptFiles, remove, replace, clear, dismissProblem };
}
