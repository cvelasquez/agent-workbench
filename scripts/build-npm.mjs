/**
 * `pnpm build:npm` — arma en `dist-npm/` el paquete que se publica en npm.
 *
 * Lo que se publica **no es este repositorio**: es un artefacto generado, con
 * la interfaz ya compilada, el servidor en un solo archivo y nada de las
 * fuentes. Eso hace que `npm pack --dry-run` muestre exactamente lo que va a
 * viajar, en vez de una lista de exclusiones que hay que ir leyendo.
 *
 *   dist-npm/
 *     package.json      generado aca; la version y las dependencias salen del repo
 *     dist/server.js    servidor y tipos compartidos, en un bundle con shebang
 *     dist/web/         la interfaz compilada por Vite
 *     README.md         con las capturas apuntando a GitHub (ver abajo)
 *     LICENSE
 *
 * **El servidor se empaqueta en un archivo, y eso resuelve `shared`.** El
 * servidor importa `@agent-workbench/shared`, que es un paquete del workspace y
 * no existe en npm: publicarlo aparte serian dos paquetes que versionar en
 * lugar de uno, y dejar el import a secas seria un paquete que no arranca.
 * Metido en el bundle, el especificador desaparece.
 *
 * Las cuatro dependencias de produccion quedan **fuera** del bundle y se
 * instalan desde npm como cualquier dependencia: `node-pty` es un modulo nativo
 * y no se puede empaquetar, y a las otras tres no se gana nada duplicandolas.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'dist-npm');
const REPO_URL = 'https://github.com/cvelasquez/agent-workbench';
const RAW_BASE = 'https://raw.githubusercontent.com/cvelasquez/agent-workbench/main/';

const readJson = (...segments) => JSON.parse(readFileSync(path.join(repoRoot, ...segments), 'utf8'));
const rootPkg = readJson('package.json');
const serverPkg = readJson('packages', 'server', 'package.json');

// Las dependencias del paquete son las del servidor, menos las del workspace
// —que viajan dentro del bundle—. Leerlas de ahi y no repetirlas a mano es lo
// que evita publicar un paquete al que le falta algo que alguien agrego ayer.
const dependencies = Object.fromEntries(
  Object.entries(serverPkg.dependencies).filter(([, range]) => !range.startsWith('workspace:')),
);

console.log('1/4  Building the interface...');
execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit', shell: true });

console.log('2/4  Bundling the server...');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.join(outDir, 'dist'), { recursive: true });

await build({
  entryPoints: [path.join(repoRoot, 'packages', 'server', 'src', 'index.ts')],
  outfile: path.join(outDir, 'dist', 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // `vite` sale del bundle aunque el paquete no lo lleve: el `import()` que lo
  // carga vive en la rama de desarrollo, que con `__PACKAGED__` en true es
  // inalcanzable. Sin marcarlo, esbuild intentaria meter Vite entero adentro.
  external: [...Object.keys(dependencies), 'vite'],
  define: { __PACKAGED__: 'true' },
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
});

console.log('3/4  Copying the interface and the package files...');
cpSync(path.join(repoRoot, 'packages', 'web', 'dist'), path.join(outDir, 'dist', 'web'), {
  recursive: true,
});
cpSync(path.join(repoRoot, 'LICENSE'), path.join(outDir, 'LICENSE'));

// npm renderiza el README en la pagina del paquete, y ahi una ruta relativa a
// `docs/` no existe: las capturas saldrian rotas. Apuntan a GitHub solo en la
// copia que se publica; la del repositorio sigue con rutas relativas, que es lo
// que funciona en GitHub y al leer el archivo de local.
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8').replaceAll(
  /(\]\(|src=")docs\//g,
  (_match, prefix) => `${prefix}${RAW_BASE}docs/`,
);
writeFileSync(path.join(outDir, 'README.md'), readme);

writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'agent-workbench',
      version: rootPkg.version,
      description: rootPkg.description,
      license: rootPkg.license,
      author: 'Christian Velasquez',
      repository: { type: 'git', url: `git+${REPO_URL}.git` },
      homepage: `${REPO_URL}#readme`,
      bugs: { url: `${REPO_URL}/issues` },
      // Como la descripcion: del `package.json` de la raiz, para no tener dos
      // listas que se desincronizan cuando se suma una CLI.
      keywords: rootPkg.keywords,
      type: 'module',
      bin: { 'agent-workbench': 'dist/server.js' },
      files: ['dist'],
      engines: rootPkg.engines,
      dependencies,
    },
    null,
    2,
  )}\n`,
);

console.log('4/4  Done.');
console.log(`\n  Package in ${outDir}`);
console.log('  Review it with:  npm pack --dry-run   (from that folder)');
console.log('  Publish it with: npm publish\n');
