/**
 * El formato de los textos pegados desde el cuadro de escritura (hito 35,
 * §6.24): la marca que queda en lo escrito, donde se pego, y las lineas que
 * abren y cierran cada texto en el mensaje.
 *
 * Va siempre en ingles: es lo que se le manda a la CLI en lenguaje natural (D1
 * del hito 35), y no cambia con el idioma de la interfaz. Lo usan los dos
 * lados: la web arma el mensaje y parte el hilo (`web/src/composer-paste.ts`),
 * y el servidor deja fuera de un titulo lo pegado (`agents/session-title.ts`).
 */

/** La marca que queda en lo escrito, donde se pego el texto. */
export function pasteReference(n: number): string {
  return `[Pasted text #${n}]`;
}

/** La linea que abre el texto pegado en el mensaje. */
export function pasteStartLine(n: number): string {
  return `[Start of pasted text #${n}]`;
}

/** La linea que lo cierra. */
export function pasteEndLine(n: number): string {
  return `[End of pasted text #${n}]`;
}

/**
 * Un texto pegado entero, sobre un texto con saltos `\n`: la linea de inicio al
 * principio de una linea, lo pegado y la linea de fin del mismo numero.
 * Grupos: 1, el salto de antes (o nada al principio); 2, el numero; 3, lo
 * pegado. Una expresion nueva en cada llamada: es global y guarda su posicion.
 */
export function pastedBlockPattern(): RegExp {
  return /(^|\n)\[Start of pasted text #(\d{1,6})\]\n([\s\S]*?)\n\[End of pasted text #\2\](?=\n|$)/g;
}

/** Una linea de inicio suelta, para el ultimo texto de un mensaje recortado. */
export function pastedBlockStartPattern(): RegExp {
  return /(^|\n)\[Start of pasted text #(\d{1,6})\]\n/;
}

/** Las marcas que hay en lo escrito. Grupo 1, el numero. Global. */
export function pasteReferencePattern(): RegExp {
  return /\[Pasted text #(\d{1,6})\]/g;
}

/** Las lineas de inicio y fin, sueltas. Global. */
export function pastedBoundaryPattern(): RegExp {
  return /\[(?:Start|End) of pasted text #\d{1,6}\]/g;
}
