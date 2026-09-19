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
 *  - **Un archivo que no es imagen** —un log, un PDF, un .docx— queda como
 *    ficha con su nombre y su peso (hito 33, §6.21). Viaja como bytes, el
 *    servidor lo guarda en la carpeta temporal de la pestana y se lo nombra a la
 *    CLI por ruta. Entra soltandolo, pegandolo o con el boton del clip.
 *
 * Lo demas —un texto corto— no se toca: lo pega el navegador como siempre. Un
 * pegado que se comporta distinto de lo esperado es peor que uno lento.
 */

import { useCallback, useState } from 'react';
import {
  MAX_SUBMIT_FILES,
  MAX_SUBMIT_FILE_BYTES,
  MAX_SUBMIT_IMAGES,
  MAX_SUBMIT_IMAGE_BYTES,
} from '@agent-workbench/shared';
import { imagesRefusedMessage } from './agent-ui.js';
import { t } from './i18n/index.js';

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
    }
  | {
      id: string;
      kind: 'file';
      /** El nombre que eligio el usuario. El servidor arma el suyo con esta pista. */
      name: string;
      /** Sin el prefijo `data:`; es lo que viaja por el socket. */
      base64: string;
      bytes: number;
    };

export interface ComposerAttachments {
  items: Attachment[];
  /** El ultimo problema al pegar (imagen enorme, formato raro), o null. */
  problem: string | null;
  /** true si el evento se consumio: quien llama debe hacer preventDefault. */
  acceptPaste: (data: DataTransfer) => boolean;
  /** Para arrastrar y soltar, y para el boton del clip. Imagenes y documentos. */
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
      setProblem(t('composer.problem.tooManyImages', { count: MAX_SUBMIT_IMAGES }));
      return;
    }

    if (file.size > MAX_SUBMIT_IMAGE_BYTES) {
      const size = Math.round(file.size / 1024 / 1024);
      const max = MAX_SUBMIT_IMAGE_BYTES / 1024 / 1024;
      setProblem(
        file.name.length > 0
          ? t('composer.problem.tooBig', { name: file.name, size, max })
          : t('composer.problem.imageTooBig', { size, max }),
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
                name: file.name.length > 0 ? file.name : t('composer.pastedImage'),
              },
            ],
      );
    };
    reader.onerror = () => setProblem(t('composer.problem.imageUnreadable'));
    reader.readAsDataURL(file);
  }, [items]);

  const addFile = useCallback((file: File) => {
    if (items.filter((item) => item.kind === 'file').length >= MAX_SUBMIT_FILES) {
      setProblem(t('composer.problem.tooManyFiles', { count: MAX_SUBMIT_FILES }));
      return;
    }
    if (file.size === 0) {
      setProblem(t('composer.problem.empty', { name: file.name }));
      return;
    }
    if (file.size > MAX_SUBMIT_FILE_BYTES) {
      setProblem(
        t('composer.problem.tooBig', {
          name: file.name,
          size: Math.round(file.size / 1024 / 1024),
          max: MAX_SUBMIT_FILE_BYTES / 1024 / 1024,
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
      setItems((current) =>
        current.filter((item) => item.kind === 'file').length >= MAX_SUBMIT_FILES
          ? current
          : [
              ...current,
              {
                id: newId(),
                kind: 'file',
                name: file.name.length > 0 ? file.name : 'archivo',
                base64: result.slice(comma + 1),
                bytes: file.size,
              },
            ],
      );
    };
    // Una carpeta soltada llega como un File que no se puede leer.
    reader.onerror = () => setProblem(t('composer.problem.unreadable', { name: file.name }));
    reader.readAsDataURL(file);
  }, [items]);

  /**
   * Las imagenes por su camino de siempre, y lo demas como documento. Una CLI
   * que no recibe imagenes las rechaza con su aviso, pero los documentos que
   * vinieran en la misma tanda entran igual.
   */
  const acceptFiles = useCallback(
    (files: FileList | File[]) => {
      const all = Array.from(files);
      const images = all.filter((file) => file.type.startsWith('image/'));
      const documents = all.filter((file) => !file.type.startsWith('image/'));
      if (images.length > 0 && !imagesAllowed) setProblem(imagesRefusedMessage());
      else for (const file of images) addImage(file);
      for (const file of documents) addFile(file);
    },
    [addImage, addFile, imagesAllowed],
  );

  const acceptPaste = useCallback(
    (data: DataTransfer): boolean => {
      // Un archivo copiado en el explorador y pegado aca llega en `files`.
      if (data.files.length > 0) {
        acceptFiles(data.files);
        return true;
      }

      const text = data.getData('text/plain');
      if (text.length === 0) return false;

      const lines = text.split('\n').length;
      if (lines < FOLD_FROM_LINES && text.length < FOLD_FROM_CHARS) return false;

      setItems((current) => [...current, { id: newId(), kind: 'text', text, lines }]);
      return true;
    },
    [acceptFiles],
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
