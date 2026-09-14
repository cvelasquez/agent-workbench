/**
 * Lo que dice en el hilo un aviso de la conversacion (hito 26): una compactacion,
 * una interrupcion o un error del proveedor.
 *
 * Desde el hito 28 la frase vive en `shared/src/conversation.ts`: el servidor la
 * usa para exportar la copia propia a Markdown y no puede importar la web. Este
 * modulo la reexporta para que el hilo y su chequeo sigan importando de aca, y
 * los tres sitios —se dibuja, se copia y se exporta— digan lo mismo.
 */

export { noticeText } from '@agent-workbench/shared';
