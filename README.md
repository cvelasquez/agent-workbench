# Agent Workbench

Una interfaz visual local para la CLI de Claude Code.

No habla con ninguna API. Lanza el binario `claude` que ya tenés instalado y
logueado, dentro de una pseudo-terminal, y le agrega alrededor lo que una
terminal sola no da: pestañas, historial navegable, la conversación como
tarjetas, un medidor de contexto, el estado de git y un árbol de archivos.

La terminal sigue siendo la terminal. Todo lo que escribís le llega a la CLI sin
que la aplicación lo toque.

![La conversación al centro; alrededor, los proyectos con su historial, las pestañas y el árbol de archivos](docs/captura-conversacion.png)

---

## Qué hace

| | |
|---|---|
| **Pestañas** | Varias sesiones vivas a la vez, cada una en su directorio. Sobreviven a un `F5`: los procesos viven en el servidor, no en la pestaña del navegador. El punto de cada una dice si el agente está trabajando, parado o esperando una respuesta. |
| **Arranque sin gastar nada** | Al abrir la app las pestañas vuelven **dormidas**: se leen enteras y no lanzan ninguna CLI. La abrís con un botón cuando quieras escribirle al agente. |
| **Historial** | Tus proyectos y conversaciones anteriores en la barra lateral, con filtro. Abrir una la retoma con `--resume`, en el mismo archivo. |
| **Conversación** | Los mensajes de la sesión activa, en vivo, con las herramientas plegadas y su resultado adentro. Búsqueda, salto entre resultados y copiado por mensaje. |
| **Medidor de contexto** | Tokens de la última petición contra la ventana del modelo. Tokens, nunca dinero. |
| **Cambios** | Rama, adelanto y atraso contra la rama de seguimiento, worktrees, y los archivos tocados con su diff. **Solo lectura.** |
| **Archivos** | El árbol del directorio de la pestaña, con carga perezosa, buscador por nombre y previsualización con resaltado de sintaxis. Un ojo muestra lo que esconden `.gitignore` y las carpetas de artefactos. Menú contextual para copiar rutas, insertarlas como `@ruta` o abrir el archivo con la app del sistema. |
| **Planes** | Los planes que escribió esa conversación en modo plan, renderizados. |
| **Tema** | Claro, oscuro, o el del sistema. |

<p>
  <img src="docs/captura-cambios.png" width="49%" alt="El panel de cambios: rama y archivos tocados, por grupo">
  <img src="docs/captura-diff.png" width="49%" alt="El diff de uno de esos archivos, en el mismo panel">
</p>

---

## Requisitos

| | |
|---|---|
| **Node.js** | 20 o superior |
| **git** | para el panel de cambios; el resto funciona sin él |
| **La CLI de Claude Code** | instalada y con sesión iniciada — [guía de instalación](https://docs.claude.com/en/docs/claude-code/setup) |

Agent Workbench **no** incluye la CLI ni la descarga: usa la que ya tenés en el
`PATH`. Si no la encuentra, te lo dice y no abre sesiones.

Probado sobre Windows 11 con PowerShell, que es la plataforma principal.
macOS y Linux funcionan igual. En Linux, la dependencia `node-pty` no trae
binario precompilado y se compila al instalar: hacen falta `python3`, `make` y
un compilador de C++ (`build-essential` en Debian y Ubuntu).

---

## Instalar

```bash
npm install -g agent-workbench
```

Después, parado en el proyecto en el que quieras trabajar:

```bash
agent-workbench
```

Para probarlo una vez sin instalarlo, `npx agent-workbench` — baja unos 60 MB
cada vez que la caché de npm está fría, casi todo del binario de la terminal.
Para uso diario conviene la instalación global.

El servidor imprime una URL con un token y la abre en el navegador:

```
  URL          http://127.0.0.1:52341/?token=…
```

Esa URL es la única forma de entrar. El token es distinto en cada arranque, y el
servidor escucha solo en `127.0.0.1`.

---

## Desde el código

Para trabajar en la aplicación, o si preferís no instalar nada global:

```bash
corepack enable pnpm
pnpm install
pnpm dev       # Vite con recarga en caliente
```

```bash
pnpm build     # compila la interfaz una vez
pnpm start     # la sirve ya compilada, sin Vite
```

### Arranque de un clic en Windows

```bash
pnpm package
```

Compila la interfaz y deja un **`Agent Workbench.cmd`** en la raíz. Doble clic y
listo: instala lo que falte, compila si hace falta y abre el navegador. Es un
archivo de texto de veinte líneas; se puede leer entero antes de ejecutarlo.

---

## Atajos

`Alt+T` nueva pestaña · `Alt+W` cerrar · `Alt+←/→` cambiar de pestaña ·
`Alt+1…9` ir a la pestaña N · `Alt+P` mostrar u ocultar el panel derecho.

El botón `?` de la barra superior los lista todos, junto con los de la CLI.

**Por qué `Alt` y no `Ctrl`:** el navegador se queda con `Ctrl+T`, `Ctrl+W` y
`Ctrl+Tab` para sus propias pestañas y el evento nunca llega a la página. No es
algo que se arregle con `preventDefault`: no hay evento que prevenir.

La aplicación captura exactamente esas cinco combinaciones y ninguna más. Todo
lo demás —`Esc`, `Esc Esc`, `Ctrl+C`, `Ctrl+R`, `Ctrl+O`, `Shift+Tab`, las
flechas y sobre todo `Alt+V`, que es el pegado de imágenes— le llega intacto a
la CLI.

---

## Qué hace la aplicación con tus datos

Nada sale de tu máquina. Sin telemetría, sin analítica, sin ninguna llamada de
red saliente.

- **Nunca toca tus credenciales.** No lee, copia ni reenvía
  `~/.claude/.credentials.json` ni ningún token. No hay login en la interfaz: si
  no iniciaste sesión, corrés `/login` dentro de la terminal y la aplicación ni
  se entera.
- **No agrega variables de autenticación** al entorno de los procesos que lanza.
  El entorno se hereda tal cual. La única excepción es que **quita**
  `CLAUDE_CODE_CHILD_SESSION` —que apaga el guardado del historial— y te avisa
  con un cartel cuando lo hace.
- **De `~/.claude/` solo lee `projects/`**, que es el historial de
  conversaciones. Lo que la aplicación guarda (pestañas abiertas, caché del
  índice) va a su propio directorio de configuración, nunca dentro de
  `~/.claude/`.
- **El servidor escucha solo en `127.0.0.1`**, en un puerto efímero, con un
  token aleatorio por arranque que exigen el WebSocket y todas las rutas HTTP,
  y rechaza peticiones cuyo `Origin` no sea el propio.
- **El panel de git es de solo lectura.** No hay commit, stage ni push. Con un
  agente editando archivos, un botón que escribe historia es exactamente lo que
  después nadie sabe quién disparó.

![Un archivo del árbol, previsualizado con resaltado de sintaxis](docs/captura-archivos.png)

---

## Si algo falla

**"No se encontró el comando `claude` en el PATH"** — la CLI no está instalada o
no está en el `PATH` del proceso que corre `pnpm dev`. Comprobalo con
`where claude` (o `which claude`).

**`node-pty` no compila al instalar.** Es un módulo nativo. Normalmente baja un
binario precompilado y no hace falta nada; si tu combinación de Node y
plataforma no tiene uno, hay que compilarlo:

- **Windows:** Visual Studio Build Tools con la carga de trabajo *Desarrollo
  para el escritorio con C++*, y Python 3.
  `npm install --global windows-build-tools` ya no se mantiene: instalá los
  Build Tools desde el instalador de Visual Studio.
- **macOS:** `xcode-select --install`.
- **Linux:** `build-essential` y `python3`.

**La terminal se queda en blanco.** El renderer por defecto es canvas a
propósito: con el addon WebGL la pestaña se congela en Windows 11 + Chrome
aunque los datos lleguen. Si querés probarlo igual, agregá `?renderer=webgl` a
la URL.

**Un cartel dice que se quitó `CLAUDE_CODE_CHILD_SESSION`.** Pasa cuando
arrancás `pnpm dev` desde adentro de una sesión de la CLI. Esa variable apaga el
guardado del historial, y sin historial no hay conversación ni medidor. La
aplicación la quita y te avisa. En uso normal —una terminal común— ni aparece.

**El panel de cambios dice que la carpeta no es un repositorio git** y sí lo es.
Fijate que `git` esté en el `PATH`. Si el mensaje es otro, es el error que
devolvió git, tal cual.

---

## Cómo está hecho

Monorepo con pnpm, TypeScript en todo.

```
packages/
  server/    Node, Express, ws, node-pty, chokidar — sirve la interfaz y hospeda las pty
  web/       Vite, React, xterm.js, highlight.js
  shared/    los tipos del protocolo, sin `any` en los bordes
```

Un solo proceso sirve la interfaz y el WebSocket en el mismo puerto: con un
único origen, el chequeo de `Origin` y el token funcionan igual en desarrollo y
en producción, sin excepciones que después nadie se acuerda de sacar.

La decisión de arquitectura que ordena el resto: **las pty viven en un registro
del servidor y el WebSocket es solo transporte.** Si el proceso muriera con el
socket, un `Ctrl+R` sin querer borraría la sesión de trabajo. Cada terminal
guarda un buffer de su salida reciente para repintar la pantalla cuando el
cliente vuelve.

[`CLAUDE.md`](CLAUDE.md) tiene el detalle, incluido el esquema real del JSONL de
la CLI —que difiere de lo que uno esperaría— y las trampas ya pisadas.
[`CONTRIBUTING.md`](CONTRIBUTING.md), cómo trabajar en el repositorio.

---

## Licencia

MIT. Ver [`LICENSE`](LICENSE).

Agent Workbench es un proyecto independiente. Funciona con la CLI de Claude Code,
pero no está afiliado a Anthropic ni respaldado por ellos.
