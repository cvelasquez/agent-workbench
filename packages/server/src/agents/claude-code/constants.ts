/**
 * Datos de compatibilidad de la CLI de Claude Code: como se llama el comando y
 * donde se instala.
 *
 * Son configuracion, no parte de la marca (regla 2.3): el producto se llama
 * Agent Workbench, y el nombre de la CLI vive en esta carpeta como dato. Los
 * lee el adaptador; el arranque y el socket los importan directo solo hasta
 * que pasen por el registro de agentes.
 */

/** Nombre del comando en el PATH. */
export const CLAUDE_CODE_COMMAND = 'claude';

export const CLAUDE_CODE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';
