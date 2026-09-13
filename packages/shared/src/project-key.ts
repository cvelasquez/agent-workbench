/**
 * La clave con la que se agrupan las sesiones en un proyecto.
 *
 * Dos CLIs, o dos lineas de la misma, pueden escribir el mismo directorio de
 * formas distintas: `D:\agent explorer\` y `d:/Agent Explorer`, o con el prefijo
 * `\\?\` de las rutas largas de Windows. Para la barra lateral son la misma
 * carpeta y tienen que caer en el mismo proyecto.
 *
 * Es **solo forma**. No toca el disco: no resuelve enlaces, ni `.`/`..`, ni
 * nombres cortos 8.3. Resolver contra el disco haria que la clave de una
 * carpeta borrada cambiara, y un proyecto del historial no puede partirse en
 * dos porque su carpeta ya no esta.
 *
 * `platform` es `process.platform` del **servidor**. En un navegador no hay
 * forma de saber si las mayusculas de una ruta importan, asi que el cliente no
 * usa la suya: la clave de un proyecto la recibe hecha, y cuando tiene que
 * comparar dos `cwd` por su cuenta —con que CLI abre el `+`, la misma regla que
 * `Alt+T` en el servidor— usa la plataforma que el servidor manda en `hello`.
 */

/** Raiz de unidad de Windows ya normalizada: `C:\`. */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\\$/;

export function normalizeCwdKey(cwd: string, platform: string): string {
  if (cwd.length === 0) return '';
  return platform === 'win32' ? windowsKey(cwd) : posixKey(cwd);
}

/**
 * Windows: barras unificadas, sin prefijo de ruta larga, sin barras repetidas
 * ni finales, y en minusculas — NTFS no distingue mayusculas.
 */
function windowsKey(cwd: string): string {
  let key = cwd.replace(/\//g, '\\');

  if (key.startsWith('\\\\?\\UNC\\')) {
    key = `\\\\${key.slice('\\\\?\\UNC\\'.length)}`;
  } else if (key.startsWith('\\\\?\\')) {
    key = key.slice('\\\\?\\'.length);
  }

  // Una ruta UNC empieza con dos barras que son parte de su forma: se
  // conservan, y se colapsa solo lo que viene despues.
  key = key.startsWith('\\\\')
    ? `\\\\${key.slice(2).replace(/\\+/g, '\\')}`
    : key.replace(/\\+/g, '\\');

  while (key.endsWith('\\') && !WINDOWS_DRIVE_ROOT.test(key)) {
    key = key.slice(0, -1);
  }

  // `toLowerCase` y no `toLocaleLowerCase`: la clave no puede depender de la
  // configuracion regional del servidor.
  return key.toLowerCase();
}

/**
 * Con que `cwd` se reanuda una sesion de la barra lateral.
 *
 * El de la sesion —el que escribio la CLI— y no el del proyecto, que es el
 * primero visto bajo la clave normalizada: una barra final o un `\\?\` de mas
 * cambian el slug, y con otro slug la CLI busca el archivo en otra carpeta.
 *
 * **Salvo que difieran solo en mayusculas, en Windows.** Ahi los dos slugs son
 * la misma carpeta para NTFS, asi que reanudar con cualquiera encuentra el
 * archivo, y el del proyecto es el que se usaba antes del Hito 24: la pestana
 * comparte las consolas de su proyecto y guarda en `workspace.json` el mismo
 * `cwd` que ellas. (Donde cae en la barra ya no depende de esto: desde el
 * Hito 25 `insertionIndex` compara la clave normalizada.)
 *
 * `platform` es la del servidor, como en `normalizeCwdKey`.
 */
export function resumeCwdFor(sessionCwd: string, projectCwd: string, platform: string): string {
  if (sessionCwd.length === 0) return projectCwd;
  if (
    platform === 'win32' &&
    sessionCwd !== projectCwd &&
    sessionCwd.toLowerCase() === projectCwd.toLowerCase()
  ) {
    return projectCwd;
  }
  return sessionCwd;
}

/**
 * macOS y Linux: barras repetidas y finales fuera, mayusculas intactas.
 *
 * macOS suele montar el disco sin distinguir mayusculas, pero no siempre, y
 * juntar dos carpetas que de verdad son distintas es peor que dejar partido un
 * proyecto que alguien escribio de dos formas.
 */
function posixKey(cwd: string): string {
  let key = cwd.replace(/\/+/g, '/');
  while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1);
  return key;
}
