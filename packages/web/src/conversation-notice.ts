/**
 * Lo que dice en el hilo un aviso de la conversacion (hito 26): una compactacion,
 * una interrupcion o un error del proveedor.
 *
 * La frase en espanol vive en `shared/src/conversation.ts`, porque el servidor
 * la usa para exportar la copia propia a Markdown y para el transcript de una
 * continuacion, y eso no se traduce (§6.23). La web dice lo mismo en el idioma
 * de la app; en espanol, exactamente lo mismo, y `check-vault.mjs` lo compara.
 */

import type { ConversationNoticePart } from '@agent-workbench/shared';
import { t } from './i18n/index.js';

export function noticeText(part: Pick<ConversationNoticePart, 'notice' | 'detail'>): string {
  switch (part.notice) {
    case 'compacted':
      return part.detail === 'auto' ? t('thread.notice.compactedAuto') : t('thread.notice.compacted');
    case 'interrupted':
      return t('thread.notice.interrupted');
    case 'error':
      // Sin detalle no se deja el "dos puntos" colgando: el error igual paso.
      return part.detail.length > 0 ? t('thread.notice.error', { detail: part.detail }) : t('thread.notice.errorNoDetail');
  }
}
