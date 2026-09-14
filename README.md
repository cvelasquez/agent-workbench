# Agent Workbench

Una interfaz visual local para las CLIs de agentes de código. Funciona con la
CLI de Claude Code, con la de Codex, con la de OpenCode y con Antigravity CLI.

No habla con ninguna API. Lanza la CLI que ya tenés instalada y logueada
—`claude`, `codex`, `opencode` o `agy`— dentro de una pseudo-terminal, y le agrega alrededor lo que
una terminal sola no da: pestañas, historial navegable, la conversación como
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
| **Historial** | Tus proyectos y conversaciones anteriores en la barra lateral, con filtro, las de Claude Code, Codex, OpenCode y Antigravity juntas bajo cada proyecto. Abrir una la retoma con su CLI, en la misma sesión. De OpenCode lee su historial y abre pestañas de su CLI, pero sin su estado ni preguntas contestables desde el chat: esas se contestan en su terminal. Antigravity publica su estado y sus tokens sólo si configurás su status line ([abajo](#antigravity-cli-estado-y-medidor-opcional)). |
| **Conversación** | Los mensajes de la sesión activa, en vivo, con las herramientas plegadas y su resultado adentro. Búsqueda, salto entre resultados y copiado por mensaje. |
| **Medidor de contexto** | Tokens de la última petición contra la ventana del modelo. Tokens, nunca dinero. |
| **Cambios** | Rama, adelanto y atraso contra la rama de seguimiento, worktrees, y los archivos tocados con su diff. **Solo lectura.** |
| **Archivos** | El árbol del directorio de la pestaña, con carga perezosa, buscador por nombre y previsualización con resaltado de sintaxis. Un ojo muestra lo que esconden `.gitignore` y las carpetas de artefactos. Menú contextual para copiar rutas, insertarlas como `@ruta` o abrir el archivo con la app del sistema. |
| **Planes** | Los planes que escribió esa conversación en modo plan, renderizados. |
| **Copia propia** | Opcional. Guarda el historial de las cuatro CLIs en una carpeta tuya y en un formato de la aplicación, para no perderlo si una CLI cambia de formato, lo borra o la desinstalás. Lo que la CLI ya no tiene sigue en la barra y se abre en Markdown, y cada proyecto se exporta a Markdown ([abajo](#copia-propia-opcional)). |
| **Memoria** | Lo que los agentes aprenden de un proyecto, en `.agents/memory/` y compartido: lo leen y lo escriben Claude Code, Codex, Antigravity y OpenCode —desde acá o desde su propia terminal— a través de `AGENTS.md` y `CLAUDE.md`. La app instala ese puente mostrando antes cada cambio, importa la memoria que ya tenía Claude Code y te da, para copiar, el fragmento de la memoria global de cada CLI. |
| **Tema** | Claro, oscuro, o el del sistema. |

<p>
  <img src="docs/captura-cambios.png" width="49%" alt="El panel de cambios: rama y archivos tocados, por grupo">
  <img src="docs/captura-diff.png" width="49%" alt="El diff de uno de esos archivos, en el mismo panel">
</p>

---

## Requisitos

| | |
|---|---|
| **Node.js** | 20 o superior. **Para ver el historial de OpenCode, 22.13 o posterior**: se lee con el SQLite que trae Node desde esa versión. Con uno anterior todo lo demás funciona igual, y el arranque te avisa |
| **git** | para el panel de cambios; el resto funciona sin él |
| **La CLI de Claude Code** | instalada y con sesión iniciada — [guía de instalación](https://docs.claude.com/en/docs/claude-code/setup) |
| **La CLI de Codex** (opcional) | instalada y con sesión iniciada — [guía](https://learn.chatgpt.com/docs/codex/cli) |
| **La CLI de OpenCode** (opcional) | instalada y con sesión iniciada — [documentación](https://opencode.ai/docs/) |
| **Antigravity CLI** (opcional) | instalada y con sesión iniciada — [guía](https://antigravity.google/docs/cli/getting-started). Para su estado y su medidor, además, `node` en el `PATH` de la CLI ([abajo](#antigravity-cli-estado-y-medidor-opcional)) |

Hace falta una de las cuatro. Agent Workbench **no** incluye ninguna CLI ni la
descarga: usa las que ya tenés en el `PATH`. Si no encuentra ninguna, te lo dice
y no abre sesiones. Con más de una instalada, el `+` de nueva pestaña abre con la
que usaste en ese proyecto, y su flecha te deja elegir otra.

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

### Antigravity CLI: estado y medidor (opcional)

Antigravity CLI no deja en ningún archivo si está trabajando, esperando que
autorices una herramienta o libre, ni cuántos tokens lleva: eso lo publica sólo
por su *status line*. Sin configurarla, sus pestañas funcionan igual —historial,
conversación, modo, modelo— pero el punto de la pestaña dice que no se sabe y el
medidor queda sin medir. Para activarlo:

1. Abrí una pestaña de Antigravity y tocá **Configurar**, al lado del medidor.
2. Copiá la línea que muestra el diálogo y fusionala con lo que ya tenga
   `~/.gemini/antigravity-cli/settings.json`. La aplicación no toca ese archivo:
   lo editás vos.
3. El diálogo pasa a **Configurada** solo en un par de segundos, o con
   **Comprobar**.

La línea corre un script que la aplicación deja en su propia carpeta. Guarda sólo
el estado, el modo, el modelo y los tokens de cada conversación, en esa misma
carpeta; no guarda tu email, tu cuota, tu plan ni el costo, que la CLI también le
pasa, y no imprime nada, así que la línea propia de la CLI queda como está. Una
vez puesta, la corre **toda** sesión de `agy`, también las que abras fuera de la
aplicación, y necesita `node` en el `PATH`. En Windows la línea entra a la
carpeta del script en vez de nombrarlo entre comillas: la CLI la ejecuta con
`cmd /c`, y ninguna comilla le llega viva a `node`.

### Copia propia (opcional)

El historial de cada conversación es de su CLI, en su formato, y una CLI puede
cambiarlo, podarlo o dejar de existir. La copia propia guarda lo mismo que ese
historial —mensajes, entradas y resultados de herramientas, imágenes y la memoria
de cada proyecto— en una carpeta tuya, en archivos que se leen sin la
aplicación. **Arranca apagada.** El botón de la copia, en la cabecera de la barra
de proyectos, abre un diálogo: primero **Medir** te dice cuánto ocuparía por CLI,
sin escribir nada, y después **Activar** la enciende. Encendida, copia todo lo
que la barra lista y no está archivado, y cada sesión que cambia la vuelve a
copiar un minuto después de que quede quieta. Las archivadas no se copian, y
archivar no borra lo ya copiado: la aplicación nunca borra nada de esa carpeta.

Por defecto va dentro de la carpeta de configuración de la aplicación
(`%APPDATA%\agent-workbench\vault` en Windows). **Cambiar carpeta…** la copia
entera a otra —una sincronizada, otra unidad— sin pisar nada, y la anterior queda
como estaba. Si la ponés en una carpeta sincronizada o en un repositorio, lo que
guarda viaja con ella.

Dos importadores de un solo uso traen historial de herramientas que la
aplicación no lee. Se corren desde el código ([abajo](#desde-el-código)) y **no
escriben nada sin `--write`**: sin él, dicen qué importarían.

- `pnpm vault:import gemini-cli [--cwd <carpeta>]` — los chats que quedaron de
  Gemini CLI; `--cwd` nombra la carpeta donde lo usabas, para ubicarlos en su
  proyecto.
- `pnpm vault:import antigravity-ide --workspace <carpeta>` — lo legible de las
  conversaciones del IDE de Antigravity en esa carpeta: la ficha de cada una y
  sus documentos `.md`. El contenido de la conversación está cifrado y queda
  marcada como historial parcial.

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
  `~/.claude/.credentials.json`, ni `auth.json` ni `config.toml` de Codex, ni
  `auth.json` ni `opencode.json` de OpenCode, ni la configuración de MCP de
  Antigravity ni su entrada en el llavero del sistema, ni ningún token. No hay login en la
  interfaz: si no iniciaste sesión, lo hacés dentro de la terminal de la CLI y la
  aplicación ni se entera.
- **No agrega variables de autenticación** al entorno de los procesos que lanza.
  El entorno se hereda tal cual. La única excepción es que **quita**
  `CLAUDE_CODE_CHILD_SESSION` —que apaga el guardado del historial— y te avisa
  con un cartel cuando lo hace.
- **De `~/.claude/` solo lee `projects/`**, que es el historial de
  conversaciones. **De `~/.codex/`, solo `sessions/` y `archived_sessions/`.**
  **De OpenCode, su base `opencode.db`, abierta en sólo lectura**, y de ella
  solo las tablas de sesiones, mensajes y partes; las de cuentas, credenciales,
  permisos y sesiones compartidas no se consultan. Lo único que deja leer esa
  base es lo que SQLite hace con cualquier lector: crea sus archivos `-wal` y
  `-shm` si faltan y le cambia la fecha a `-shm`. Nunca corre un comando de
  OpenCode sobre ella. **De Antigravity, de `~/.gemini/antigravity-cli/`**: los
  transcripts de cada conversación, `history.jsonl`, la última conversación de
  cada carpeta, y de `settings.json` sólo el modelo y la status line; si el log
  propio de una pestaña no aparece, los `log/cli-*.log` de la CLI, que traen tus
  mensajes y el email de la cuenta, sólo para encontrar el id de la conversación
  y sin guardar ninguna línea; y de
  `~/.gemini/config/projects/`, la carpeta de cada proyecto. Su índice de
  conversaciones lo lee de una **copia** temporal, para no dejar archivos al lado
  del original. Nada de `~/.gemini/antigravity/`, que es su IDE, salvo lo que lee
  el importador del IDE cuando lo corrés vos: de las conversaciones de esa
  carpeta, sus documentos `.md`, y de nuevo una copia temporal del índice.
  Lo que la aplicación guarda (pestañas abiertas, caché del índice, el script de
  la status line, la copia propia si la encendés) va a su propio directorio de
  configuración o a la carpeta que elijas para la copia, nunca dentro de la
  carpeta de una CLI. El log de cada pestaña de Antigravity, que trae tus
  mensajes, queda en la carpeta temporal con permisos sólo tuyos y se borra en el
  primer arranque de la aplicación pasadas 24 horas.
- **En tus proyectos escribe una sola cosa, y sólo si confirmás:** la memoria
  compartida. Antes muestra archivo por archivo qué va a cambiar, y se limita a
  `.agents/memory/`, a lo que está entre sus marcas en `AGENTS.md` y
  `CLAUDE.md`, y a unas líneas al final de `.gitignore`. La configuración global
  de cada CLI no la toca.
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

**No aparece el historial de OpenCode.** Mirá la línea `Historial` del arranque.
Si dice que esa versión de Node no trae `node:sqlite`, actualizá Node a la 22.13
o posterior. Si no hay línea, no encontró la base: está en
`~/.local/share/opencode/opencode.db`, o donde diga `OPENCODE_DB` o
`XDG_DATA_HOME`.

**Una pestaña de Antigravity no muestra su estado ni el medidor.** Mirá la línea
`Status line` del arranque, debajo de la CLI: si dice que no está configurada, o
que hay otra, seguí los pasos de
[arriba](#antigravity-cli-estado-y-medidor-opcional). Si la configuraste y la
terminal de la CLI muestra `Statusline Error`, lo más probable es que `node` no
esté en el `PATH` de esa sesión. Mientras la línea no publique nada, la pestaña
se trata como si no la hubieras configurado.

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

Agent Workbench es un proyecto independiente. Funciona con las CLIs de Claude
Code, de Codex, de OpenCode y de Antigravity, pero no está afiliado a Anthropic,
a OpenAI, a los autores de OpenCode ni a Google, ni respaldado por ellos.
