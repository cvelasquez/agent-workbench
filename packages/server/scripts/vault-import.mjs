/**
 * Importadores de un solo uso de la copia propia (hito 28).
 *
 *   pnpm vault:import gemini-cli      [--cwd <ruta>]... [--write]
 *   pnpm vault:import antigravity-ide --workspace <ruta> [--write]
 *
 * En seco por defecto: sin `--write` no escribe nada. Toda la logica esta en
 * `src/vault/importers/command.ts`, que es lo que prueba el chequeo; aca solo
 * se conecta con la terminal. No lanza ninguna CLI ni necesita el servidor.
 */

import os from 'node:os';
import { runVaultImport } from '../src/vault/importers/command.ts';

process.exitCode = await runVaultImport(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  homeDir: os.homedir(),
  platform: process.platform,
  now: () => Date.now(),
});
