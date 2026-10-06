/**
 * Donde deja `PasteStore` lo que se pega en el cuadro de escritura, y como se
 * reconoce una de sus imagenes por la ruta.
 *
 * Vive aparte de `paste-store.ts` porque lo lee tambien el adaptador de Claude
 * Code: un mensaje que se manda con el agente trabajando nombra sus imagenes
 * por ruta y la CLI no las adjunta (§4.4.1), asi que el hilo las reconoce por
 * la forma de esa ruta y las busca aca.
 */

import { tmpdir } from 'node:os';
import path from 'node:path';

/** La carpeta de lo pegado, con una subcarpeta por pestana (`PasteStore`). */
export function pasteRoot(): string {
  return path.join(tmpdir(), 'agent-workbench', 'pasted');
}

/**
 * `<...>/agent-workbench/pasted/<pestana>/pegada-<n>-<8 hex>.<ext>`: el nombre
 * que pone `PasteStore.save`, con la extension que decidio la firma. Si cambia
 * alla, cambia aca.
 *
 * Se mira la cola de la ruta y no la carpeta temporal de esta maquina: decide
 * que mostrar, no que leer. Lo que se lee del disco pasa ademas por
 * `resolveInside` contra `pasteRoot()` (`conversation-image.ts`).
 */
const PASTED_IMAGE =
  /(?:^|[\\/])agent-workbench[\\/]pasted[\\/][A-Za-z0-9_-]+[\\/]pegada-\d+-[0-9a-f]{8}\.(png|jpg|gif|webp)$/i;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** El tipo de una imagen pegada en el cuadro, por su ruta; null si la ruta no es de una. */
export function pastedImageMediaType(filePath: string): string | null {
  const extension = PASTED_IMAGE.exec(filePath)?.[1];
  return extension === undefined ? null : (MEDIA_TYPES[extension.toLowerCase()] ?? null);
}
