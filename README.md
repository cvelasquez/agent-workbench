# Agent Workbench

Una interfaz visual local para las CLIs de agentes de código. Funciona con la
CLI de Claude Code, con la de Codex, con la de OpenCode y con Antigravity CLI.

No habla con ninguna API. Lanza la CLI que ya tenés instalada y logueada
—`claude`, `codex`, `opencode` o `agy`— dentro de una pseudo-terminal, y le
agrega alrededor lo que una terminal sola no da: pestañas, historial navegable,
la conversación como tarjetas, un medidor de contexto, el estado de git y un
árbol de archivos.

La terminal sigue siendo la terminal. Todo lo que escribís le llega a la CLI sin
que la aplicación lo toque.

![La conversación al centro; alrededor, los proyectos con su historial, las pestañas de las cuatro CLIs y el árbol de archivos](docs/captura-conversacion.png)

---

## Qué hace

| | |
|---|---|
| **Pestañas** | Varias sesiones vivas a la vez, de cualquiera de las CLIs, cada una en su directorio. Sobreviven a un `F5`: los procesos viven en el servidor, no en la pestaña del navegador. El punto de cada una dice si el agente está trabajando, parado o esperando una respuesta, en las CLIs que publican su estado ([abajo](#varias-clis)). |
| **Arranque sin gastar nada** | Al abrir la app las pestañas vuelven **dormidas**: se leen enteras y no lanzan ninguna CLI. La abrís con un botón cuando quieras escribirle al agente. |
| **Historial** | Tus proyectos y conversaciones anteriores en la barra lateral, con filtro, y las de las cuatro CLIs juntas bajo cada proyecto, cada una con su insignia. Abrir una la retoma con su CLI, en la misma sesión. **Archivar historial…** esconde de una vez las sesiones de una CLI anteriores a hoy, sin borrar nada, y se deshace. |
| **Conversación** | Los mensajes de la sesión activa, en vivo, con las herramientas plegadas y su resultado adentro. Búsqueda, salto entre resultados, copiado por mensaje y, según la CLI, las preguntas del agente se contestan desde el chat. |
| **Continuar con…** | Con más de una CLI instalada, una conversación se sigue con otra CLI en la misma carpeta. El agente nuevo arranca de un recorte de los últimos turnos, no del contexto que tenía el anterior. |
| **Buscar en todo** | Con más de una CLI y algo guardado en la copia propia, el filtro de la barra busca también en el texto de todas las conversaciones guardadas, no sólo en sus títulos. |
| **Medidor de contexto** | Tokens de la última petición contra la ventana del modelo. Tokens, nunca dinero. |
| **Cambios** | Rama, adelanto y atraso contra la rama de seguimiento, worktrees, y los archivos tocados con su diff. **Solo lectura.** |
| **Archivos** | El árbol del directorio de la pestaña, con buscador por nombre y previsualización con resaltado de sintaxis. Menú contextual para copiar rutas, insertarlas como `@ruta` o abrir el archivo con la app del sistema. |
| **Planes** | Los planes que escribió esa conversación en modo plan, renderizados. |
| **Memoria compartida** | Lo que los agentes aprenden de un proyecto, en `.agents/memory/`, y lo leen y escriben las cuatro CLIs ([abajo](#memoria-compartida)). |
| **Copia propia** | Opcional. El historial de las cuatro CLIs en una carpeta tuya y en un formato de la aplicación, para no perderlo si una CLI cambia de formato, lo borra o la desinstalás ([abajo](#copia-propia-opcional)). |
| **Tema** | Claro, oscuro, o el del sistema. |

<p>
  <img src="docs/captura-cambios.png" width="49%" alt="El panel de cambios: rama y archivos tocados, por grupo">
  <img src="docs/captura-diff.png" width="49%" alt="El diff de uno de esos archivos, en el mismo panel">
</p>

### Varias CLIs

Con más de una CLI instalada, cada sesión de la barra y cada pestaña lleva la
insignia de su CLI, y el `+` de nueva pestaña abre con la que usaste en ese
proyecto; su flecha te deja elegir otra. Con una sola, no ves nada de esto.

<img src="docs/captura-clis.png" width="45%" alt="La barra de proyectos con sesiones de varias CLIs, cada una con su insignia, y el menú del + con las cuatro CLIs y sus versiones">

**No todas las CLIs dan lo mismo.** Claude Code deja en sus archivos todo lo que
la aplicación necesita. Codex deja el historial y los tokens del medidor, pero no
su estado, ni los permisos pendientes, ni sus preguntas, ni el modelo: su punto
dice que no se sabe, no hay aviso de "esperando" y las preguntas se contestan en
su terminal. Con OpenCode, la aplicación arranca un servidor local de OpenCode
cuando abrís una pestaña, y de ahí salen su estado, el aviso de que espera un
permiso y las preguntas que se contestan desde el chat. Antigravity CLI publica
su estado y sus tokens sólo si configurás su status line
([abajo](#antigravity-cli-estado-y-medidor-opcional)).

---

## Requisitos

| | |
|---|---|
| **Node.js** | 20 o superior. **Para ver el historial de OpenCode y los títulos de Antigravity CLI, 22.13 o posterior**: se leen con el SQLite que trae Node desde esa versión. Con uno anterior todo lo demás funciona igual; el arranque avisa lo de OpenCode, y Antigravity CLI lista sus conversaciones sin los títulos ni las carpetas de su índice |
| **git** | para el panel de cambios; el resto funciona sin él |
| **Al menos una CLI** | instalada y con sesión iniciada (tabla de abajo) |

| CLI | Comando | Instalación |
|---|---|---|
| Claude Code | `claude` | [guía de instalación](https://docs.claude.com/en/docs/claude-code/setup) |
| Codex | `codex` | [guía](https://learn.chatgpt.com/docs/codex/cli) |
| OpenCode | `opencode` | [documentación](https://opencode.ai/docs/) |
| Antigravity CLI | `agy` | [guía](https://antigravity.google/docs/cli/getting-started). Para su estado y su medidor, además, `node` en el `PATH` de la CLI |

Agent Workbench **no** incluye ninguna CLI ni la descarga: usa las que ya tenés
en el `PATH`. Si no encuentra ninguna, te lo dice y no abre sesiones.

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

### Memoria compartida

Cada CLI guarda lo que aprende de un proyecto en su propia carpeta, y las demás
no lo ven. La solapa **Memoria** instala un puente para que las cuatro usen la
misma: notas en `.agents/memory/` del proyecto, que cada CLI lee y escribe
—desde acá o desde su propia terminal— a través de `AGENTS.md` y `CLAUDE.md`.

**Ver cambios** muestra archivo por archivo qué se va a escribir, y nada se toca
hasta que confirmás. Al instalar importa la memoria que ya tenía Claude Code de
ese proyecto. La memoria global de cada CLI no la escribe la aplicación: te da
el fragmento para que lo pegues vos.

<img src="docs/captura-memoria.png" width="70%" alt="La solapa Memoria con el puente instalado para las cuatro CLIs y las notas importadas">

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

Lo que la CLI ya no tiene sigue en la barra, marcado como copia, y se abre en
Markdown; cada proyecto se exporta a Markdown. Y con la copia encendida y más de
una CLI, el filtro de la barra ofrece **En conversaciones**: busca en el texto de
todo lo copiado, de todas las CLIs.

<img src="docs/captura-buscador.png" width="40%" alt="El buscador en conversaciones: un acierto en una sesión de cada CLI, con su fragmento">

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

`Alt+T` nueva pestaña · `Alt+W` cerrar · `Alt+←/→` (o `Alt+RePág/AvPág`)
cambiar de pestaña · `Alt+P` mostrar u ocultar el panel derecho · `Shift+Tab`,
fuera de la terminal, volver a la pestaña anterior.

El botón `?` de la barra superior los lista todos, junto con los de la CLI de la
pestaña.

**Por qué `Alt` y no `Ctrl`:** el navegador se queda con `Ctrl+T`, `Ctrl+W` y
`Ctrl+Tab` para sus propias pestañas y el evento nunca llega a la página. No es
algo que se arregle con `preventDefault`: no hay evento que prevenir.

La aplicación captura exactamente esas combinaciones y ninguna más. `Shift+Tab`
sólo cuando el foco no está en la terminal, porque adentro es la tecla con la que
la CLI cambia de modo. Todo lo demás —`Esc`, `Esc Esc`, `Ctrl+C`, `Ctrl+R`,
`Ctrl+O`, las flechas y sobre todo `Alt+V`, que es el pegado de imágenes— le
llega intacto a la CLI.

---

## Qué hace la aplicación con tus datos

Nada sale de tu máquina. Sin telemetría, sin analítica, sin ninguna llamada de
red saliente. La excepción es la propia CLI trabajando: la que abrís en una
pestaña, y el servidor de OpenCode de abajo, hablan con el proveedor del modelo
como lo harían abiertas a mano.

**Nunca toca tus credenciales.** No hay login en la interfaz: si no iniciaste
sesión, lo hacés dentro de la terminal de la CLI y la aplicación ni se entera.

**De cada CLI lee sólo esto, y en su carpeta no escribe nada.** Los
importadores de la copia propia, cuando los corrés vos, leen además lo que dice
[su sección](#copia-propia-opcional).

| CLI | Lee | No abre nunca |
|---|---|---|
| Claude Code | de `~/.claude/`: `projects/` (el historial, y la memoria de cada proyecto para importarla), `sessions/` (si la CLI está esperando una respuesta) y `plans/` (sólo los planes que nombró la conversación que estás mirando) | `.credentials.json` ni ningún token |
| Codex | de `~/.codex/` (o `CODEX_HOME`): `sessions/` y `archived_sessions/` | `auth.json`, `config.toml` ni sus bases `*.sqlite` |
| OpenCode | su base `opencode.db`, abierta en sólo lectura, y de ella sólo las tablas de sesiones, mensajes y partes; y su catálogo de modelos, para el tamaño de la ventana | `auth.json`, `opencode.json`, ni las tablas de cuentas, credenciales, permisos y sesiones compartidas |
| Antigravity CLI | de `~/.gemini/antigravity-cli/`: los transcripts de cada conversación, `history.jsonl`, la última conversación de cada carpeta, de `settings.json` sólo el modelo y la status line, y su índice de conversaciones, de una **copia** temporal; de `~/.gemini/config/projects/`, la carpeta de cada proyecto | la configuración de MCP, su entrada en el llavero del sistema, el contenido de `conversations/`, ni `~/.gemini/antigravity/`, que es su IDE |

Tres huellas que conviene saber:

- **Leer la base de OpenCode** hace lo que SQLite hace con cualquier lector: crea
  sus archivos `-wal` y `-shm` si faltan y le cambia la fecha a `-shm`. Para
  leerla nunca corre un comando de OpenCode.
- **Si el log propio de una pestaña de Antigravity no aparece**, lee los
  `log/cli-*.log` de la CLI, que traen tus mensajes y el email de la cuenta, sólo
  para encontrar el id de la conversación y sin guardar ninguna línea.
- **Con OpenCode, la aplicación corre su servidor local**, `opencode serve`: uno
  solo, desde que abrís la primera pestaña de OpenCode hasta cinco minutos
  después de cerrar la última, o hasta que cerrás la aplicación. Escucha en
  `127.0.0.1`, con un puerto efímero y una contraseña distinta en cada arranque,
  aunque tu configuración de OpenCode diga otra cosa. La aplicación le pide sólo
  el estado de las sesiones, los permisos y preguntas pendientes, crear una
  sesión, contestar una pregunta y cortar una sesión: nada de tu configuración ni
  de tus cuentas.

**No agrega variables de autenticación** al entorno de las CLIs que lanza. El
entorno se hereda tal cual, con dos excepciones: **quita**
`CLAUDE_CODE_CHILD_SESSION` —que apaga el guardado del historial— y te avisa con
un cartel cuando lo hace; y al servidor de OpenCode le **agrega** una sola
variable, `OPENCODE_SERVER_PASSWORD`, con esa contraseña de cada arranque. No es
la de ninguna cuenta, y la variable no llega a ninguna pestaña: cada pestaña de
OpenCode recibe la contraseña en su línea de comando (`attach --password`), donde
la ven los demás procesos de tu usuario. Sólo sirve para ese servidor y deja de
valer al cerrar la aplicación.

**Lo que escribe la aplicación:**

- **En su propio directorio de configuración:** las pestañas abiertas, la caché
  del índice, las notas, las sesiones archivadas, el script de la status line de
  Antigravity y, si la encendés, la copia propia (o en la carpeta que elijas).
- **En la carpeta temporal:** las imágenes que pegás; el log de cada pestaña de
  Antigravity, que trae tus mensajes, con permisos sólo tuyos y borrado en el
  primer arranque pasadas 24 horas; y el transcript de una conversación que
  continuás en otra CLI, que se borra al cerrar esa pestaña o a las 24 horas.
- **En tus proyectos, una sola cosa y sólo si confirmás:** la memoria
  compartida. Se limita a `.agents/memory/`, a lo que está entre sus marcas en
  `AGENTS.md` y `CLAUDE.md`, y a unas líneas al final de `.gitignore`.

**El servidor escucha solo en `127.0.0.1`**, en un puerto efímero, con un token
aleatorio por arranque que exigen el WebSocket y todas las rutas HTTP, y rechaza
peticiones cuyo `Origin` no sea el propio.

**El panel de git es de solo lectura.** No hay commit, stage ni push. Con un
agente editando archivos, un botón que escribe historia es exactamente lo que
después nadie sabe quién disparó.

![Un archivo del árbol, previsualizado con resaltado de sintaxis](docs/captura-archivos.png)

---

## Si algo falla

**"No se encontró el comando `claude` en el PATH"**, seguido de "También
funciona con: …" — la aplicación no encontró ninguna de las cuatro CLIs en el
`PATH` del proceso que la corre. Comprobalo con `where claude` (o `which claude`),
y lo mismo con `codex`, `opencode` o `agy`. Las CLIs se buscan al arrancar: si
instalaste una con la aplicación abierta, volvé a arrancarla.

**No aparece el historial de OpenCode.** Mirá la línea `Historial` del arranque.
Si dice que esa versión de Node no trae `node:sqlite`, actualizá Node a la 22.13
o posterior. Si no hay línea, no encontró la base: está en
`~/.local/share/opencode/opencode.db`, o donde diga `OPENCODE_DB` o
`XDG_DATA_HOME`.

**Una pestaña de OpenCode no abre y dice "No se pudo arrancar el servidor de
OpenCode".** La pestaña se engancha a un `opencode serve` que la aplicación
lanza, y el motivo va después de los dos puntos. Si no queda claro, abrí
`opencode` en una terminal común: si tampoco arranca, el problema es de esa
instalación de OpenCode.

**Una pestaña de OpenCode dice que el servidor se cerró.** El `opencode serve`
terminó y la terminal de la pestaña quedó sin conexión. **Relanzar**, en la misma
barra, abre otro servidor y vuelve a enganchar la pestaña a la misma sesión.

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
arrancás la aplicación desde adentro de una sesión de la CLI de Claude Code. Esa
variable apaga el guardado del historial, y sin historial no hay conversación ni
medidor. La aplicación la quita y te avisa. En uso normal —una terminal común—
ni aparece.

**El panel de cambios dice que la carpeta no es un repositorio git** y sí lo es.
Fijate que `git` esté en el `PATH`. Si el mensaje es otro, es el error que
devolvió git, tal cual.

---

## Cómo está hecho

Monorepo con pnpm, TypeScript en todo.

```
packages/
  server/    Node, Express, ws, node-pty, chokidar — sirve la interfaz y hospeda las pty
    src/agents/   un adaptador por CLI: lo único del servidor que conoce a cada una
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

La otra: **el servidor genérico no nombra ninguna CLI.** Lo que sabe de cada una
—dónde guarda, cómo se lanza, qué se lee y qué no se abre nunca— vive en su
adaptador, y la interfaz dibuja cada control según lo que esa CLI declara.

[`CLAUDE.md`](CLAUDE.md) tiene el detalle, incluido el formato real del historial
de cada CLI —que difiere de lo que uno esperaría— y las trampas ya pisadas.
[`CONTRIBUTING.md`](CONTRIBUTING.md), cómo trabajar en el repositorio. Las
capturas de este README salen de `pnpm demo:shots`, sobre datos inventados.

---

## Licencia

MIT. Ver [`LICENSE`](LICENSE).

Agent Workbench es un proyecto independiente. Funciona con las CLIs de Claude
Code, de Codex, de OpenCode y de Antigravity, pero no está afiliado a Anthropic,
a OpenAI, a los autores de OpenCode ni a Google, ni respaldado por ellos.
