/**
 * La forma de un id de sesion de OpenCode.
 *
 * Vive aparte de `index.ts` desde el hito 29 porque la usan tambien el cliente
 * del `serve` (una sesion creada por API) y el lanzamiento, que `index.ts`
 * importa: con la constante en `index.ts` serian importaciones en circulo.
 */

/**
 * Los ids de sesion que acepta `-s` (y `attach --session`). Medido: los 295
 * ids de la base de esta maquina son `ses_` y 26 alfanumericos, 0 con otro
 * caracter.
 *
 * No es un adorno: `opencode` resuelve al shim `.cmd` y se lanza detras de
 * `cmd.exe /c`, y node-pty solo pone comillas a los argumentos con espacios. Un
 * id `ses_x&<comando>` —del cliente, de un `workspace.json` tocado, o de una
 * respuesta del `serve`— lo ejecutaria `cmd`.
 */
export const OPENCODE_SESSION_ID_PATTERN = /^ses_[0-9A-Za-z]{20,40}$/;
