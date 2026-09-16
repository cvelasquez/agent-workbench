# Contribuir a Agent Workbench

Gracias por mirar el proyecto. Es una herramienta chica y personal, así que las
reglas también son pocas. Las que hay, sin embargo, no son negociables: casi
todas existen porque algo salió mal una vez.

---

## Antes de escribir código

Leé [`CLAUDE.md`](CLAUDE.md). No es documentación de cortesía: tiene las reglas
duras del proyecto, el mapa del código y un índice de la carpeta [`docs/`](docs)
que dice qué archivo leer antes de tocar cada zona. Ahí está el detalle de las
trampas ya pisadas: el esquema real del JSONL de cada CLI, por qué
`kill('SIGTERM')` tumbaba el servidor en Windows, por qué el renderer WebGL está
apagado. Un cambio que ignora esas reglas se descarta aunque funcione.

La numeración de las secciones (`§3.2`, `§11.12`) es estable y la citan los
comentarios del código: al mover texto entre archivos, viaja con él.

---

## Las cuatro reglas que no se discuten

1. **La aplicación no toca credenciales de ninguna CLI.** No se lee, copia ni
   reenvía `~/.claude/.credentials.json`, ni las de Codex, OpenCode o
   Antigravity, ni ningún token: la lista de lo que no se abre nunca, por CLI,
   está en `CLAUDE.md` §2.1. No hay login en la interfaz. No se inyectan
   variables de autenticación en el entorno de los procesos que se lanzan.

2. **Los binarios de las CLIs van sin modificar y sin empaquetar.** Se buscan en
   el `PATH`. No se incluyen en el repositorio, no se descargan y no se envuelven
   de forma que altere su comportamiento.

3. **El servidor escucha solo en `127.0.0.1`**, con puerto efímero y un token
   aleatorio por arranque que exigen tanto el WebSocket como todas las rutas
   HTTP. Sin telemetría y sin ninguna llamada de red saliente.

4. **La marca.** El producto se llama Agent Workbench. Ni el nombre, ni el logo,
   ni ninguna funcionalidad llevan el nombre de una CLI ni de su fabricante. En
   el código, identificadores neutros (`agentCli`, `cliBinary`, `sessionIndex`).
   El README puede decir en texto plano que funciona con las CLIs de Claude
   Code, Codex, OpenCode y Antigravity: es compatibilidad, no respaldo.

   Con la misma lógica, el nombre de una CLI puede aparecer en el código en dos
   sitios, como dato de compatibilidad: el id de su adaptador (`AGENT_IDS` en
   `packages/shared/src/agents.ts`) y la carpeta de ese adaptador
   (`packages/server/src/agents/claude-code/`, `codex/`, `opencode/`,
   `antigravity/`), donde los identificadores sí la nombran
   (`createClaudeCodeAdapter`). Fuera de esas carpetas la nombran el
   registro de adaptadores y dos módulos que trabajan con archivos de CLIs
   concretas: la memoria compartida (`memory-bridge.ts`, que conoce el slug
   de Claude Code y el archivo de instrucciones de cada CLI) y el importador
   de un solo uso del IDE de Antigravity (`vault/importers/`). El servidor
   genérico —terminales, hub, índice, socket— habla con la interfaz y no sabe
   qué CLI tiene delante (`CLAUDE.md` §2.3 y §3.2).

Cualquier cambio que roce estos puntos se revisa mirando esos cuatro criterios
antes que nada.

---

## Estilo

- **Español** para conversación, comentarios y documentación.
  **Inglés** para identificadores y nombres de archivo.
- **Sin `any` en los tipos del protocolo.** Lo que entra por la red es
  `unknown` hasta que un parser lo estrecha (`packages/shared/src/validation.ts`).
- Los comentarios explican **por qué**, no qué. Si un comentario se puede
  deducir leyendo la línea de abajo, sobra. Si documenta una trampa, vale oro.
- **Sin dependencias innecesarias.** Cada paquete nuevo se justifica en una
  línea en el pull request. Hoy la lista completa es: express, ws, node-pty,
  chokidar en el servidor; react, xterm y highlight.js en la interfaz.
- Commits chicos con mensajes descriptivos. Una rama por tema.

---

## Antes de abrir un pull request

```bash
pnpm typecheck   # los tres paquetes
pnpm check       # chequeos del seguidor de JSONL, del parseo de git y del guardia de rutas
pnpm build       # que la interfaz compile para producción
```

`pnpm check` no es una formalidad. Cubre lo que se rompe en silencio:

- líneas de JSONL partidas entre dos lecturas y caracteres UTF-8 cortados al
  medio;
- el registro de rename de `git status --porcelain=v2`, que se lleva un campo
  extra y desincroniza el parser entero si no se lo consume;
- el guardia de rutas, que es lo único que impide que una ruta del cliente lea
  fuera del directorio de la pestaña.

Si tocás alguna de esas tres zonas, agregá el caso al chequeo correspondiente.

---

## Probar a mano

Hay cosas que ningún chequeo automático cubre, porque necesitan una CLI real
respondiendo:

- que los mensajes nuevos aparezcan en el panel de conversación mientras la CLI
  escribe;
- que `Ctrl+V` y `Alt+V` sigan llegando intactos a la CLI (el pegado de
  imágenes se rompe si alguien intercepta esas teclas);
- que recargar el navegador conserve los procesos y repinte la pantalla;
- que cerrar una pestaña realmente termine el proceso, sin dejar huérfanos.

## Datos de demo y capturas

`pnpm demo` levanta la app con proyectos y conversaciones inventadas, sin tocar
tu historial ni tu configuración: un home falso con historiales inventados de
las cuatro CLIs, las cuatro CLIs simuladas primero en el `PATH` —la demo no
arranca si encuentra una de verdad— y, en Windows, una unidad `W:` montada con
`subst` para que ninguna ruta lleve tu usuario. Sirve para trabajar en la interfaz con datos estables y para
verla sin exponer nada propio.

`pnpm demo:shots` (después de `pnpm build`) saca las capturas del README con
ese mismo entorno y el Chrome que tengas instalado. **Las capturas del repo
salen de ahí y de ningún otro lado**: son públicas, y una captura de tu
instalación real muestra los nombres de tus proyectos. Si cambiás la interfaz,
volvé a generarlas con ese comando en vez de reemplazarlas a mano.

## Publicar una versión

Lo que se publica en npm es `dist-npm/`, que genera `pnpm build:npm` — no el
repositorio. Sale de la versión del `package.json` de la raíz, así que empezá
por ahí:

```bash
npm version patch --no-git-tag-version   # o minor / major, en la raíz
pnpm build:npm
cd dist-npm && npm pack --dry-run        # revisá la lista de archivos
npm publish                              # pide el segundo factor
```

npm **no deja republicar una versión ya publicada**, ni siquiera idéntica: si
algo salió mal, se corrige y se sube la siguiente. Por eso conviene mirar
`npm pack --dry-run` antes, y probar el `.tgz` instalándolo en una carpeta
vacía:

```bash
cd dist-npm && npm pack
mkdir /tmp/prueba && cd /tmp/prueba && npm init -y
npm install /ruta/al/agent-workbench-<version>.tgz
./node_modules/.bin/agent-workbench
```

---

## Qué encaja y qué no

**Encaja:** arreglos de compatibilidad entre plataformas, casos del formato del
historial que cambian entre versiones de una CLI, accesibilidad, rendimiento con
repositorios o historiales grandes. Una CLI nueva también, detrás de su propio
adaptador (`CLAUDE.md` §3.2), con sus lecturas declaradas en §2.1 y un escritor
de su formato en la demo (§7.3).

**No encaja:** operaciones de git que escriben (commit, stage, push) desde la
interfaz —hay un agente editando archivos y la terminal es donde el comando se
ve antes de ejecutarse—, cualquier forma de autenticación dentro de la app, y
opciones de configuración que se puedan evitar con un buen valor por defecto.
La aplicación tiene que ser entendible sin manual: el esfuerzo mental del
usuario va en su proyecto, no en nuestra herramienta.
