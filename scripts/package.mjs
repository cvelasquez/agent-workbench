/**
 * `pnpm package` — deja el proyecto listo para arrancar de un clic en Windows.
 *
 * No empaqueta un ejecutable ni incluye la CLI: compila la interfaz y escribe
 * un lanzador. Esa es la diferencia entre "arranque de un clic" y "instalador",
 * y aca solo hace falta lo primero.
 *
 * El lanzador es un `.cmd` a proposito, no un `.exe` ni un instalador:
 *
 *  - Se lee. El usuario puede abrirlo con el bloc de notas y ver exactamente
 *    que hace un archivo que va a ejecutar en su maquina.
 *  - No hay nada que firmar, y por lo tanto ninguna advertencia de SmartScreen
 *    que enseñe a ignorar advertencias.
 *  - Repara solo el caso comun: si faltan las dependencias o la compilacion,
 *    las hace antes de arrancar.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = path.join(repoRoot, 'Agent Workbench.cmd');

/**
 * `call` delante de cada `pnpm`: pnpm en Windows es un `.cmd`, y sin `call` el
 * control no vuelve a este script — se ejecuta el primero y el resto del
 * archivo no corre nunca.
 */
const LAUNCHER = `@echo off
rem Lanzador de Agent Workbench. Generado por "pnpm package".
rem Se puede leer entero: no hace nada que no diga aca.
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo Instalando dependencias por primera vez...
  call corepack enable pnpm
  call pnpm install
  if errorlevel 1 goto error
)

if not exist "packages\\web\\dist\\index.html" (
  echo Compilando la interfaz...
  call pnpm build
  if errorlevel 1 goto error
)

echo Arrancando Agent Workbench. Cerra esta ventana o presiona Ctrl+C para salir.
call pnpm start
if errorlevel 1 goto error
goto fin

:error
echo.
echo Algo fallo. La salida de arriba dice que.
pause

:fin
endlocal
`;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    // pnpm es un .cmd en Windows: sin shell, spawn no lo encuentra.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\nFallo: ${command} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

console.log('Compilando la interfaz...');
run('pnpm', ['build']);

if (!existsSync(path.join(repoRoot, 'packages', 'web', 'dist', 'index.html'))) {
  console.error('La compilacion no dejo packages/web/dist/index.html.');
  process.exit(1);
}

writeFileSync(launcherPath, LAUNCHER, 'utf8');

console.log('');
console.log('Listo.');
console.log(`  Lanzador   ${launcherPath}`);
console.log('  Doble clic en ese archivo arranca la app y abre el navegador.');
console.log('');
if (process.platform !== 'win32') {
  console.log('  En macOS y Linux el equivalente es "pnpm start" en esta carpeta.');
  console.log('');
}
