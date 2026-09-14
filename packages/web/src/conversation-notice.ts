/**
 * Lo que dice en el hilo un aviso de la conversacion (hito 26): una compactacion,
 * una interrupcion o un error del proveedor.
 *
 * Es una frase y no un componente porque se usa en tres sitios —se dibuja, se
 * copia y se busca— y los tres tienen que decir lo mismo. Sin JSX, para que lo
 * pruebe el chequeo.
 */

import type { ConversationNoticePart } from '@agent-workbench/shared';

export function noticeText(part: Pick<ConversationNoticePart, 'notice' | 'detail'>): string {
  switch (part.notice) {
    case 'compacted':
      return part.detail === 'auto' ? 'Contexto compactado automáticamente' : 'Contexto compactado';
    case 'interrupted':
      return 'Interrumpido';
    case 'error':
      // Sin detalle no se deja el "dos puntos" colgando: el error igual paso.
      return part.detail.length > 0
        ? `La CLI devolvió un error: ${part.detail}`
        : 'La CLI devolvió un error';
  }
}
