/**
 * Previsualizacion de un archivo, de solo lectura.
 *
 * Dos cosas que valen la pena tener presentes:
 *
 *  - **El resaltador se carga cuando se abre el primer archivo, no antes.**
 *    highlight.js con sus 25 gramaticas pesa mas que el resto de la interfaz
 *    junta, y lo primero que tiene que aparecer en esta app es la terminal.
 *    Con el `import()` dinamico queda en un fragmento aparte que solo baja
 *    quien abre un archivo.
 *  - **Lo que entra a `dangerouslySetInnerHTML` sale siempre de highlight.js**,
 *    que escapa el texto. Si no hay gramatica, `highlightCode` devuelve null y
 *    el texto se renderiza como texto. Cualquier cambio en este archivo tiene
 *    que conservar esa propiedad.
 *
 * Los numeros de linea van en una columna aparte y el codigo **no** se parte en
 * lineas: partirlo romperia los bloques que highlight.js abre en una linea y
 * cierra en otra (un comentario de varias lineas, por ejemplo). La columna se
 * alinea porque las dos usan la misma `line-height` y el codigo no envuelve.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FilePreview } from '@agent-workbench/shared';
import { t } from './i18n/index.js';

interface FilePreviewViewProps {
  preview: FilePreview;
}

export function FilePreviewView({ preview }: FilePreviewViewProps): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (preview.binary || preview.language === null) {
      setHtml(null);
      return;
    }

    let cancelled = false;
    void import('./highlight.js')
      .then(({ highlightCode }) => {
        if (cancelled) return;
        setHtml(highlightCode(preview.text, preview.language));
      })
      .catch(() => {
        // Sin resaltador se muestra el texto plano. No es un error que valga
        // la pena mostrarle al usuario.
        if (!cancelled) setHtml(null);
      });

    return () => {
      cancelled = true;
      setHtml(null);
    };
  }, [preview.text, preview.language, preview.binary]);

  const lineCount = useMemo(
    () => (preview.binary ? 0 : preview.text.split('\n').length),
    [preview.text, preview.binary],
  );

  if (preview.binary) {
    return <p className="panel-note">{t('files.preview.binary')}</p>;
  }

  return (
    <div className="panel-scroll">
      <div className="preview">
        <div className="preview-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        {html !== null ? (
          <pre className="preview-code hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="preview-code">{preview.text}</pre>
        )}
      </div>

      {preview.truncated && <p className="panel-note">{t('files.preview.truncated')}</p>}
    </div>
  );
}
