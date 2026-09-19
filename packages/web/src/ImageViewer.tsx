/**
 * Ver una imagen entera, superpuesta a todo lo demas.
 *
 * Lo usan los dos sitios donde hay miniaturas, y en los dos por el mismo
 * motivo: **una miniatura de 56 o 180 px no alcanza para leer una captura**,
 * que es para lo que se pegan.
 *
 * Va superpuesto y no en el sitio, y eso no es estetica:
 *
 *  - En el cuadro de escritura, agrandar la ficha empujaria hacia abajo el
 *    texto que se esta escribiendo. La imagen se mira justo cuando uno esta
 *    redactando el mensaje que la acompana.
 *  - En el hilo, agrandar en el sitio —que es lo que hacia hasta el hito 19—
 *    reacomoda la conversacion **bajo el cursor**: la linea que uno estaba
 *    leyendo se va a otro lado en el mismo clic que amplia la imagen.
 *
 * `Escape` cierra el visor y **no llega a nadie mas**. Importa porque en el
 * cuadro de escritura esa misma tecla interrumpe a la CLI (§5.0): sin
 * detenerla aca, mirar una captura y cerrarla le cortaria el trabajo al
 * agente. Por eso el listener va en captura y detiene la propagacion.
 *
 * **Se dibuja en `document.body`, no donde se lo invoca**, y eso no es
 * prolijidad: encontrado probandolo. La ficha del cuadro de escritura es un
 * `figure` con `line-height: 0` —para que la miniatura no arrastre el
 * interlineado— y `overflow: hidden`. El visor heredaba lo primero y el pie
 * salia con **cero de alto**: el nombre del archivo estaba en el DOM y no se
 * veia. Un elemento que se superpone a toda la ventana no puede depender de
 * los estilos del sitio desde el que se abrio.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n/index.js';

interface ImageViewerProps {
  src: string;
  /** Lo que se lee al pie. Un nombre de archivo, o de donde salio. */
  caption: string;
  onClose: () => void;
}

export function ImageViewer({ src, caption, onClose }: ImageViewerProps): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return createPortal(
    /*
      Cierra el fondo, no la imagen. Un clic sobre la propia imagen es lo que
      uno hace para senalar algo mientras la mira; cerrarle el visor ahi es la
      forma mas facil de que haya que volver a abrirlo.
    */
    <div className="viewer" onClick={onClose} role="presentation">
      <div className="viewer-frame" onClick={(event) => event.stopPropagation()}>
        <img className="viewer-image" src={src} alt={caption} />
      </div>
      <div className="viewer-bar">
        <span className="viewer-caption">{caption}</span>
        <button className="viewer-close" onClick={onClose} title={t('common.closeEsc')}>
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}
