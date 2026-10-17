# Agent Workbench

[![npm](https://img.shields.io/npm/v/agent-workbench)](https://www.npmjs.com/package/agent-workbench)
[![CI](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/cvelasquez/agent-workbench/actions/workflows/ci.yml)
[![licencia: MIT](https://img.shields.io/npm/l/agent-workbench)](LICENSE)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

[English](README.md) · **Español** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**Una interfaz visual para los agentes de código que ya usas: las CLIs de
Claude Code, Codex, OpenCode, Antigravity y Pi.** Corre en tu equipo y se abre
en tu navegador. Usa las CLIs que ya tienes instaladas y con tu sesión
iniciada, nunca toca tus credenciales y no hace llamadas de red propias.

```bash
npx agent-workbench
```

![Un recorrido: la conversación como tarjetas, los archivos cambiados y un diff, una pestaña por CLI, y una conversación que sigue con otra CLI](assets/demo.webp)

## Cómo funciona

Agent Workbench no habla con ningún servicio de IA. Arranca la CLI que ya
tienes —`claude`, `codex`, `opencode`, `agy` o `pi`— dentro de una terminal
real, y le agrega alrededor lo que una terminal sola no te da: pestañas, tus
conversaciones anteriores, la conversación como tarjetas fáciles de leer, un
medidor de contexto, los archivos que cambiaron y un árbol de archivos.

La terminal sigue siendo la terminal: todo lo que escribes va directo a la CLI.

---

## Qué incluye

| | |
|---|---|
| **Pestañas** | Varios agentes a la vez, de cualquier CLI, cada uno en su carpeta. Un punto en cada pestaña te dice si el agente está trabajando, libre o esperándote. Recargar la página no detiene nada: las CLIs corren en el servidor, no en el navegador. |
| **Arranque rápido** | Al abrir la app, tus pestañas vuelven **dormidas**: puedes leerlas completas, y ninguna CLI arranca hasta que hagas clic en **Abrir CLI**. |
| **Historial** | Tus proyectos y conversaciones anteriores en la barra lateral, de todas las CLIs, con un filtro. Haz clic en una para retomarla donde la dejaste, con su CLI. Archiva sesiones antiguas o un proyecto entero para ordenar: no se borra nada, y se puede deshacer. |
| **Conversación** | Los mensajes como tarjetas, en vivo, con las llamadas a herramientas plegadas. Los mensajes anteriores se cargan a medida que subes. Busca, copia cualquier mensaje o bloque de código, y salta a tu mensaje anterior (↑) o al final (↓). Una fila al pie dice cuándo llegó tu mensaje a la CLI y si el agente sigue trabajando. Según la CLI, puedes contestar ahí mismo las preguntas del agente. Un archivo del proyecto que el agente nombra se abre en la solapa Archivos con un clic. Con Claude Code, un mensaje que detienes antes de que el agente empiece vuelve al cuadro para corregirlo, y **↩** en un mensaje vuelve a antes de él: la conversación y, si quieres, el código. Un mensaje que mandas con el agente trabajando espera al final, marcado en cola; según la CLI, **Forzar envío ahora** hace que el agente lo lea ya. |
| **Cuadro de escritura** | Espacio para escribir, pegar imágenes y adjuntar archivos, y el texto largo que pegas queda como una ficha compacta. Lo que estás escribiendo no se pierde si cierras la app, y aparece en vivo en todas las ventanas abiertas. Shift+Enter sigue una lista numerada o con viñetas. |
| **Medidor de contexto** | Cuánto de la ventana de contexto del modelo usa la conversación. Tokens, nunca dinero. |
| **Cambios** | La rama, los archivos cambiados y su diff. **Solo lectura**: sin botones de commit ni de push. |
| **Archivos** | El árbol de archivos del proyecto, con búsqueda y vista previa con resaltado de sintaxis. Abre varios archivos a la vez, cada uno en su solapa; los archivos Markdown se abren con formato. Un clic pone la ruta de un archivo en tu mensaje. Edita un archivo de texto, un `.env` por ejemplo, y guárdalo ahí mismo: si el agente lo cambió mientras lo editabas, no se pisa nada, y pasas tus cambios a la versión nueva. |
| **Planes** | Los planes y los documentos `.md` que escribió la conversación, con formato. Un clic pone la ruta de un documento en tu mensaje. |
| **Notas** | Un bloc de notas junto a la conversación, con imágenes incluidas. Con Claude Code, un clic manda una nota a una conversación nueva. |
| **Consola** | La terminal de tu sistema, abajo, en la carpeta del proyecto: PowerShell, cmd o Git Bash en Windows; bash o zsh en macOS y Linux. |
| **Continuar con…** | Con más de una CLI, sigue una conversación con otra CLI en la misma carpeta. El agente nuevo arranca de un transcript de los últimos turnos. |
| **Notificaciones** | Un sonido, y notificaciones del sistema opcionales, cuando un agente termina o te está esperando. |
| **Ajustes** | ⚙ en la cabecera: el idioma, el tema de la terminal, qué paneles se ven, qué consola se abre y qué CLIs usa la app. |
| **Nueve idiomas** | English, Español, 简体中文, 日本語, Português (Brasil), Русский, 한국어, Français y Deutsch. Sigue el idioma de tu navegador. |
| **Tema** | Claro, oscuro o el del sistema. La terminal queda oscura por defecto, para que los colores de las CLIs se sigan leyendo bien. |

Opcionales y apagados por defecto: la
[memoria compartida](#memoria-compartida-entre-clis) entre CLIs, un
[respaldo](#respaldo-de-tu-historial) de tu historial, el
[acceso remoto](#acceso-remoto-por-ssh) desde otro equipo o un teléfono, y una
[app de Android](#la-app-de-android).

<p>
  <img src="assets/captura-cambios.png" width="49%" alt="El panel Cambios: la rama y los archivos cambiados, por grupo">
  <img src="assets/captura-diff.png" width="49%" alt="El diff de uno de esos archivos, en el mismo panel">
</p>

### Con más de una CLI

Cada sesión y cada pestaña muestran una pequeña insignia con su CLI, y el `+`
de pestaña nueva te deja elegir con qué CLI abrirla. Con una sola CLI no ves
nada de esto.

<img src="assets/captura-clis.png" width="45%" alt="La barra de proyectos con sesiones de varias CLIs, cada una con su insignia, y el menú + con las cinco CLIs y sus versiones">

**No todas las CLIs comparten la misma información**, así que algunas funciones
dependen de la CLI:

| | Claude Code | Codex | OpenCode | Antigravity CLI | Pi |
|---|:---:|:---:|:---:|:---:|:---:|
| Punto de la pestaña: trabajando, libre, esperándote | ✓ | — | ✓ ¹ | ✓ ² | ✓ |
| Contestar las preguntas del agente desde la conversación | ✓ | — | ✓ ¹ | — | — |
| Medidor de contexto | ✓ | ✓ | ✓ | ✓ ² | ✓ |
| Selectores de modo y de modelo | ✓ | — | — | ✓ | ✓ ³ |
| Pegar imágenes | ✓ | ✓ | ✓ | — | ✓ ³ |
| Solapa Planes | ✓ | — | — | — | — |
| Mandar una nota a una conversación nueva | ✓ | — | — | — | — |

Para todo lo demás, la terminal propia de la CLI siempre está ahí: donde hay un
«—», las preguntas, por ejemplo, se contestan en ella.

¹ Con OpenCode, la app arranca un servidor local de OpenCode para obtener esto
([detalles](#tus-datos-y-la-seguridad)).
² Solo si configuras su status line
([cómo](#antigravity-cli-estado-y-medidor-de-contexto)).
³ Pi no tiene modos de permisos: sus selectores son el modelo y el nivel de
razonamiento. Y no adjunta lo que pegas: una imagen viaja como una ruta de
archivo que el modelo abre por su cuenta.

---

## Requisitos

- **Node.js 20 o posterior.** Para ver el historial de OpenCode y los títulos de
  las conversaciones de Antigravity CLI, **22.13 o posterior**: se leen con el
  SQLite que Node trae integrado desde esa versión. Con una anterior, todo lo
  demás funciona.
- **git**, para el panel Cambios. Todo lo demás funciona sin él.
- **Al menos una CLI**, instalada y con tu sesión iniciada:

| CLI | Comando | Cómo instalarla |
|---|---|---|
| Claude Code | `claude` | [guía de instalación](https://docs.claude.com/en/docs/claude-code/setup) |
| Codex | `codex` | [guía](https://learn.chatgpt.com/docs/codex/cli) |
| OpenCode | `opencode` | [documentación](https://opencode.ai/docs/) |
| Antigravity CLI | `agy` | [guía](https://antigravity.google/docs/cli/getting-started) |
| Pi | `pi` | [pi.dev](https://pi.dev) |

Agent Workbench no incluye ni descarga ninguna CLI: encuentra las que están en
tu `PATH`. Si no hay ninguna, te lo dice y no abre sesiones.

**Plataformas.** Se desarrolla y se usa a diario en Windows 11 con PowerShell.
En macOS y Linux, cada cambio se instala y se arranca de forma automática, pero
se usan menos en el día a día: los reportes son bienvenidos. En Linux, la
instalación compila el módulo de la terminal, así que necesitas `python3`,
`make` y un compilador de C++ (`build-essential` en Debian y Ubuntu).

---

## Instalar y arrancar

```bash
npm install -g agent-workbench
```

Después, desde la carpeta del proyecto en el que quieres trabajar:

```bash
agent-workbench
```

Se abre tu navegador en una dirección como esta:

```
  URL          http://127.0.0.1:52341/?token=…
```

Esa dirección es la única forma de entrar: el token cambia en cada arranque, y
la app solo escucha en tu propio equipo (`127.0.0.1`).

Para probarla una vez sin instalarla: `npx agent-workbench`. La primera vez
descarga unos 60 MB, sobre todo el módulo nativo de la terminal. Para el uso
diario, es mejor la instalación global.

---

## Atajos de teclado

| Teclas | Acción |
|---|---|
| `Alt+T` | Nueva pestaña |
| `Alt+W` | Cerrar la pestaña |
| `Alt+←` / `Alt+→` (o `Alt+PgUp` / `Alt+PgDn`) | Pestaña anterior / siguiente |
| `Alt+P` | Mostrar u ocultar el panel derecho |
| `Shift+Tab`, fuera de la terminal | Volver a la pestaña anterior |

El botón `?` de la cabecera los lista todos, junto con los atajos propios de la
CLI activa. Usan `Alt` porque el navegador se queda con `Ctrl+T`, `Ctrl+W` y
`Ctrl+Tab` para sus propias pestañas y nunca se los pasa a la página.

Todas las demás teclas —`Esc`, `Ctrl+C`, `Ctrl+R`, `Ctrl+O`, las flechas,
`Alt+V` para pegar imágenes— le llegan a la CLI tal cual. `Ctrl+V` también: lo
que haga ahí depende de la CLI. Solo en la consola de abajo, en Windows,
`Ctrl+V` pega texto, como en Windows Terminal.

---

## Extras opcionales

### Memoria compartida entre CLIs

Cada CLI guarda lo que aprende de un proyecto en su propio lugar, y las demás no
lo ven. La solapa **Memoria** arma una sola memoria para todas: notas en la
carpeta `.agents/memory/` del proyecto, que cada CLI lee y escribe —desde aquí
o desde su propia terminal— a través de `AGENTS.md` y `CLAUDE.md`. Al principio
la solapa está oculta: muéstrala desde ⚙ Ajustes.

**Ver cambios** muestra, archivo por archivo, lo que se escribiría, y no se toca
nada hasta que confirmes. Al instalarla, se importa la memoria que Claude Code
ya tenía de ese proyecto. La app no edita la configuración global de cada CLI:
te da el fragmento para que lo pegues tú.

<img src="assets/captura-memoria.png" width="70%" alt="La solapa Memoria con el puente instalado para las cinco CLIs y las notas importadas">

### Respaldo de tu historial

Cada CLI es dueña de su historial: puede cambiarle el formato o recortarlo, y
también se puede desinstalar. El respaldo guarda una copia de tus conversaciones
—mensajes, llamadas a herramientas y sus resultados, imágenes, y la memoria de
cada proyecto— en una carpeta tuya, en archivos que puedes leer sin la app.

**Está apagado por defecto.** Ábrelo con el botón del respaldo, arriba en la
barra de proyectos, o desde ⚙ Ajustes. **Medir** te dice cuánto espacio
ocuparía por CLI, sin escribir nada, y **Activar** lo pone en marcha. Desde ese
momento copia todo lo que está en la barra y no está archivado, y vuelve a
copiar una conversación un minuto después de que deja de cambiar. Nunca borra
nada de esa carpeta.

Con el respaldo encendido:

- Las conversaciones que una CLI ya no tiene siguen en la barra, marcadas como
  respaldo, y se abren en Markdown.
- Cualquier proyecto se puede exportar a Markdown.
- Con más de una CLI, el filtro de la barra puede buscar **En conversaciones**:
  el texto de todo lo copiado, de todas las CLIs.

<img src="assets/captura-buscador.png" width="40%" alt="Búsqueda en conversaciones: un acierto en una sesión de cada CLI, con su fragmento">

Por defecto vive en la carpeta de configuración de la app
(`%APPDATA%\agent-workbench\vault` en Windows). **Cambiar carpeta…** lo copia a
otra —una carpeta sincronizada, otro disco— sin sobrescribir nada, y deja la
anterior como estaba. Si lo pones en una carpeta sincronizada o en un
repositorio, tus conversaciones viajan con él.

<details>
<summary>Importar historial de Gemini CLI y del Antigravity IDE</summary>

Dos importadores de un solo uso traen el historial de herramientas que la app no
lee. Se corren desde el código fuente ([más abajo](#desde-el-código-fuente)) y
**no escriben nada sin `--write`**: sin esa opción, solo te dicen qué
importarían.

- `pnpm vault:import gemini-cli [--cwd <folder>]` — los chats que quedaron de
  Gemini CLI. `--cwd` es la carpeta donde lo usabas, para guardarlos en ese
  proyecto.
- `pnpm vault:import antigravity-ide --workspace <folder>` — lo que se puede
  leer de las conversaciones del Antigravity IDE en esa carpeta: el resumen de
  cada una y sus documentos `.md`. La conversación en sí está cifrada, así que se
  marca como historial parcial.

</details>

### Antigravity CLI: estado y medidor de contexto

Antigravity CLI solo dice si está trabajando o esperándote, y cuántos tokens
lleva usados, a través de su *status line*. Sin ella, sus pestañas funcionan
normalmente, pero el punto de la pestaña dice que el estado es desconocido y el
medidor queda vacío. Para activarla:

1. Abre una pestaña de Antigravity y haz clic en **Configurar**, junto al
   medidor.
2. Copia la línea que aparece y agrégala a lo que ya tiene
   `~/.gemini/antigravity-cli/settings.json`. La app no edita ese archivo: lo
   editas tú.
3. En un par de segundos, o con **Comprobar**, el diálogo dice **Configurada**.

La línea corre un pequeño script guardado en la carpeta propia de la app. Guarda
solo el estado, el modo, el modelo y los tokens de cada conversación —no tu
email, tu cuota, tu plan ni el costo, que la CLI también le pasa— y no imprime
nada, así que la status line propia de la CLI queda como estaba. Una vez puesta,
corre en **todas** las sesiones de `agy`, también en las que abras fuera de la
app, y necesita `node` en el `PATH`.

### Acceso remoto por SSH

Deja Agent Workbench corriendo en un equipo y úsalo desde otro de tu red, en su
navegador, sin ninguna CLI instalada ahí. **La app nunca se abre a la red**:
sigue escuchando solo en `127.0.0.1`, y el otro equipo llega a ella por un túnel
SSH. El túnel es además lo que hace que funcione: a través de él, el otro
navegador ve la app como `localhost`, que es lo que los navegadores exigen para
el portapapeles y las notificaciones. **Está apagado por defecto.**

**1. En el equipo donde corre la app, una vez: enciende su servidor SSH.** Es
un cambio del sistema que pide permisos de administrador, así que la app no lo
hace por ti.

- **Windows 10/11** — en PowerShell *como administrador*. La primera línea
  descarga e instala el servidor, y tarda unos minutos: espera a que vuelva a
  aparecer el cursor.

  ```powershell
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Start-Service sshd
  Set-Service -Name sshd -StartupType Automatic
  ```

- **macOS** — Ajustes del Sistema → General → Compartir → **Sesión remota**.
- **Linux** — instala y enciende el servidor OpenSSH de tu distribución. En
  Debian o Ubuntu:

  ```bash
  sudo apt install openssh-server
  sudo systemctl enable --now ssh
  ```

**2. En la app: ⇄ en la cabecera → Encender el acceso remoto, y después
reinicia Agent Workbench.** El túnel necesita un puerto que no cambie, así que
la app usa uno fijo (24837 por defecto; lo puedes cambiar), y el puerto se elige
al arrancar. Reiniciar cierra las CLIs abiertas; tus pestañas vuelven dormidas.
*Apagarlo* se aplica en el acto.

**3. En el otro equipo, cada vez: abre el túnel.** El diálogo muestra el comando
listo para copiar:

```
ssh -N -L 24837:127.0.0.1:24837 you@your-computer
```

Déjalo corriendo, y **usa el mismo puerto en los dos extremos**: con otro puerto
local, la app responde 403. Si agregas
`-o ServerAliveInterval=30 -o ExitOnForwardFailure=yes`, el túnel se da cuenta
de que se cayó el wifi en vez de quedarse colgado. En Windows puedes guardar el
comando en un archivo `.cmd` y abrirlo con doble clic.

**4. Empareja ese equipo, una vez.** En el diálogo, **Emparejar un equipo** te
da una dirección con un código de un solo uso, como
`http://localhost:24837/?pair=K7QM-X2RD`. Ábrela en el navegador del otro
equipo antes de que pasen cinco minutos. A partir de ahí, ese navegador solo
abre `http://localhost:24837`, incluso después de que la app se reinicie. El
diálogo lista los equipos emparejados, y **Revocar** le corta el acceso a uno
en el acto.

Un equipo emparejado puede usar toda la app, salvo administrar el acceso remoto
y las pocas cosas que abrirían una ventana en el equipo donde corre la app, como
*Abrir con la app del sistema*. Lo indica una insignia **Remoto** en la
cabecera. Ten en cuenta que la app incluye una consola y lanza agentes, así que
un equipo emparejado puede correr comandos en tu equipo, igual que tú.
**Empareja solo equipos que sean tuyos.**

**En un teléfono o una tableta.** Por el mismo túnel, el navegador de un
teléfono muestra un diseño de una columna: la barra de proyectos entra
deslizándose desde el costado, las pestañas van en la cabecera, y una franja
cambia entre la conversación, la CLI, los cambios, los archivos y el resto.
Aparece en cualquier ventana de menos de 768 px de ancho. En una pantalla
táctil, Enter en el cuadro de escritura hace un salto de línea (el que envía es
el botón de enviar), y arrastrar un dedo sobre una terminal la desplaza.

<details>
<summary>Una llave SSH más segura, que solo sirve para el túnel (recomendado)</summary>

El inicio de sesión por SSH es el de tu usuario en ese equipo, así que una
contraseña o una llave que abre el túnel también abre ahí una terminal completa.
Puedes crear una llave que solo sirva para el túnel: genera una en el otro
equipo (`ssh-keygen -t ed25519`) y agrega su parte pública a `authorized_keys`
en el equipo donde corre la app, con estas opciones al principio:

```
restrict,port-forwarding,permitopen="127.0.0.1:24837",command="exit" ssh-ed25519 AAAA… other-computer
```

Con `restrict` a secas, la llave todavía puede correr comandos;
`command="exit"` es lo que cierra esa puerta, y el túnel nunca pide un comando.
En Windows, si tu usuario es administrador, ese archivo es
`C:\ProgramData\ssh\administrators_authorized_keys`, y solo deben poder
escribirlo Administradores y SYSTEM; si no, es
`%USERPROFILE%\.ssh\authorized_keys`. Para comprobarlo, prueba
`ssh you@your-computer whoami` con esa llave: no debería imprimir nada y debería
terminar en el acto, mientras el túnel `-N -L` sigue funcionando.

</details>

### La app de Android

Una app para Android 10 o posterior abre el túnel por ti y muestra la misma
interfaz, servida por tu equipo, con el diseño para teléfono. Se queda conectada
en segundo plano y te avisa cuando un agente termina o te está esperando,
incluso con la pantalla apagada; tocar un aviso abre esa pestaña. Cuando vuelve
el wifi, se reconecta sola.

Necesita el acceso remoto encendido y el servidor SSH del equipo corriendo
(pasos 1 y 2 de arriba). Descárgala de
[Google Play](https://play.google.com/store/apps/details?id=io.github.cvelasquez.agentworkbench),
o compílala tú desde [`android/`](android/) como explica
[`CONTRIBUTING.md`](CONTRIBUTING.md#the-android-app).

**Para emparejarla, una vez:**

1. En el diálogo ⇄, elige **Emparejar un teléfono**. Muestra una línea para
   pegar en una terminal de este equipo, y un código QR. En Windows, si tu
   usuario es administrador, la línea va en PowerShell *como administrador*; el
   diálogo te lo indica.
2. Pega la línea. Autoriza la llave del teléfono solo para el túnel: con ella,
   el teléfono llega a la app y a nada más — ni terminal ni comandos.
3. Escanea el código QR con la app. El código sirve una sola vez y durante
   cinco minutos, y el diálogo tiene que quedar abierto hasta que el teléfono se
   conecte.

El código QR lleva la llave SSH privada del teléfono. Tu equipo la guarda solo
en memoria hasta que el teléfono la usa, y nunca la escribe en disco:
**no compartas una foto de ese código QR**. El teléfono recuerda la huella SSH
de tu equipo en la primera conexión, y si alguna vez cambia, se niega a
conectarse y te avisa.

**Para quitar un teléfono**, usa **Revocar** en el diálogo y borra su línea de
`authorized_keys` (termina en `agent-workbench-phone`). En el teléfono,
**Ajustes → Olvidar este equipo** borra su llave y su credencial.

Si los avisos llegan tarde con el teléfono quieto, deja que la app funcione sin
restricciones de batería: **Ajustes → Abrir los ajustes de batería de la app**.
Lo que la app guarda en el teléfono y los permisos que pide están en
[`PRIVACY.md`](PRIVACY.md).

---

## Tus datos y la seguridad

- **Agent Workbench no manda nada a ninguna parte.** Sin telemetría, sin
  analítica, sin llamadas de red propias. La app de Android solo habla con tu
  equipo.
- **Cada CLI sigue haciendo por su cuenta lo que haría si la abrieras a mano:**
  habla con su proveedor de IA, y puede buscar actualizaciones o mandar sus
  propios datos de uso. Agent Workbench no le agrega nada a eso, y tampoco lo
  apaga: no cambia la configuración de ninguna CLI. Lo que manda cada CLI está
  en su propia documentación.
- **Nunca toca tus credenciales.** No hay pantalla de inicio de sesión: si una
  CLI te pide iniciar sesión, lo haces en su propia terminal, y la app ni se
  entera.
- **Lee el historial de las CLIs y no escribe nada en sus carpetas.** La tabla
  de abajo lista lo que lee y lo que nunca abre.
- **Solo escribe en sus propias carpetas**, más dos cosas en tus proyectos: la
  memoria compartida, solo si lo confirmas, y un archivo que tú editas y guardas
  en la solapa Archivos.
- **El servidor solo escucha en tu equipo** (`127.0.0.1`), en un puerto al azar,
  con un token aleatorio nuevo en cada arranque, y rechaza las peticiones que
  vienen de otras páginas web. El acceso remoto no cambia eso: el puerto pasa a
  ser fijo, siempre en `127.0.0.1`, y SSH —que tú enciendes y controlas— hace el
  resto.
- **El panel Cambios es de solo lectura.** Sin commit, stage ni push: con un
  agente editando archivos, un botón que escribe historial es justo el tipo de
  cosa en la que, después, nadie sabe quién lo presionó.

| CLI | Qué lee | Qué nunca abre |
|---|---|---|
| Claude Code | De `~/.claude/`: `projects/` (el historial, y la memoria de cada proyecto, para importarla), `sessions/` (si la CLI te está esperando) y `plans/`. Para la solapa Planes, también los archivos `.md` que la conversación escribió en el proyecto o en la carpeta temporal de esa sesión — **solo los que nombra la conversación que estás viendo**, sin recorrer ninguna carpeta | `.credentials.json` ni ningún token |
| Codex | De `~/.codex/` (o `CODEX_HOME`): `sessions/` y `archived_sessions/` | `auth.json`, `config.toml` ni sus bases de datos `*.sqlite` |
| OpenCode | Su base de datos `opencode.db`, abierta en solo lectura, y de ella solo las sesiones, los mensajes y las partes; y su catálogo de modelos, para el tamaño de la ventana de contexto | `auth.json`, `opencode.json` ni las tablas de cuentas, credenciales, permisos y sesiones compartidas |
| Antigravity CLI | De `~/.gemini/antigravity-cli/`: los transcripts de cada conversación, `history.jsonl`, la última conversación de cada carpeta, el modelo y la status line de `settings.json`, y una **copia** temporal de su índice de conversaciones; de `~/.gemini/config/projects/`, la carpeta de cada proyecto | Su configuración de MCP, su entrada en el llavero del sistema, el contenido de `conversations/`, y `~/.gemini/antigravity/`, que es su IDE |
| Pi | De `~/.pi/agent/` (o `PI_CODING_AGENT_DIR`): las sesiones de `sessions/`, y `models-store.json`, su catálogo de modelos, para el tamaño de la ventana de contexto y el selector de modelo. Del paquete de Pi instalado: su `package.json`, para saber la versión sin correr Pi, y su lista de modelos integrada | `auth.json`, `models.json`, `settings.json` ni su configuración de MCP |

Los [importadores del respaldo](#respaldo-de-tu-historial), cuando los corres,
también leen lo que dice su sección. La lista completa, archivo por archivo,
está en [`ARCHITECTURE.md`](ARCHITECTURE.md#4-what-is-read-from-each-cli).

<details>
<summary>La letra pequeña: rastros, variables de entorno y lo que escribe la app</summary>

**Tres rastros que conviene conocer:**

- **Leer la base de datos de OpenCode** hace lo que SQLite hace con cualquier
  lector: crea sus archivos `-wal` y `-shm` si faltan y actualiza la fecha de
  `-shm`. La app nunca corre un comando de OpenCode para leerla.
- **Si el log propio de una pestaña de Antigravity no aparece**, la app lee los
  archivos `log/cli-*.log` de la CLI, que contienen tus mensajes y el email de
  la cuenta, solo para encontrar el id de la conversación, y sin guardar ninguna
  línea.
- **Con OpenCode, la app corre un servidor local de OpenCode**
  (`opencode serve`): uno solo, desde que abres la primera pestaña de OpenCode
  hasta cinco minutos después de cerrar la última, o hasta que cierras la app.
  Escucha en `127.0.0.1`, en un puerto al azar, con una contraseña distinta en
  cada arranque, aunque tu configuración de OpenCode diga otra cosa. La app solo
  le pide el estado de las sesiones, los permisos y las preguntas pendientes,
  crear una sesión, contestar una pregunta y detener una sesión: nada sobre tu
  configuración ni tus cuentas.

**Variables de entorno.** Las CLIs heredan tu entorno tal cual, sin variables de
inicio de sesión agregadas. Dos excepciones: la app **quita**
`CLAUDE_CODE_CHILD_SESSION` —que apaga el guardado del historial— y te lo avisa
con un cartel cuando lo hace; y **agrega** una variable al servidor de
OpenCode, `OPENCODE_SERVER_PASSWORD`, con esa contraseña de cada arranque. No
es la contraseña de ninguna cuenta, y no llega a ninguna pestaña: cada pestaña
de OpenCode la recibe en su línea de comando (`attach --password`), donde otros
programas que corren con tu usuario pueden verla. Solo sirve para ese servidor
y deja de servir cuando cierras la app.

**Lo que Pi manda por su cuenta.** Al arrancar, Pi consulta en pi.dev su última
versión y su catálogo de modelos, y reporta ahí cada instalación y cada
actualización. Ese reporte lo apagas en Pi, no aquí:
`enableInstallTelemetry: false` en la configuración de Pi, o la variable de
entorno `PI_TELEMETRY=0`.

**Lo que escribe la app:**

- **En su propia carpeta de configuración:** las pestañas abiertas, la caché
  del índice, las notas, las sesiones archivadas, los mensajes sin enviar, el
  script de la status line de Antigravity y, si lo enciendes, el respaldo (o en
  la carpeta que elijas). Con el acceso remoto encendido, también la lista de
  equipos emparejados: un nombre, dos fechas y un hash de la credencial de cada
  uno — nunca la credencial en sí.
- **En la carpeta temporal:** las imágenes y los archivos que pegas o adjuntas;
  el log de cada pestaña de Antigravity, con tus mensajes, que solo tú puedes
  leer y que se borra en el primer arranque tras cumplir 24 horas; y el
  transcript de una conversación que continúas con otra CLI, que se borra al
  cerrar esa pestaña o pasadas 24 horas.
- **En tus proyectos, dos cosas:** la memoria compartida, solo si confirmas,
  limitada a `.agents/memory/`, a lo que está entre sus marcas en `AGENTS.md` y
  `CLAUDE.md`, y a unas líneas al final de `.gitignore`; y un archivo que editas
  en la solapa Archivos, cuando lo guardas. Eso solo reemplaza el contenido de un
  archivo que ya existe: no se crea, renombra ni borra nada, y nada se escribe
  dentro de la carpeta de una CLI.

</details>

![Un archivo del árbol, en vista previa con resaltado de sintaxis](assets/captura-archivos.png)

---

## Solución de problemas

**«No se encontró el comando "claude" en el PATH», seguido de «También funciona
con: …»** — la app no encontró ninguna de las CLIs. Compruébalo con
`where claude` en Windows (`which claude` en los demás sistemas), y lo mismo con
`codex`, `opencode`, `agy` o `pi`. Las CLIs se buscan al arrancar: si instalaste
una con la app abierta, reiníciala.

**Pi está instalada, pero la app no la ve.** La app no corre `pi` para
encontrarla: lee la versión del paquete de Pi, que está junto al comando. Eso
funciona cuando Pi se instaló con npm o con el instalador de pi.dev; un binario
`pi` suelto no se reconoce. Y si otro programa llamado `pi` aparece antes en tu
`PATH`, la app lo ignora y lo dice en su consola.

**En una pestaña de Pi, el cuadro de escritura dice que la CLI está esperando
una respuesta tuya.** Es Pi, que pregunta si puede confiar en la carpeta del
proyecto. Contesta esa pregunta en la solapa **CLI**: la app nunca la contesta
por ti.

**No aparece el historial de OpenCode.** Mira la línea `History` al arrancar la
app. Si dice que esa versión de Node no incluye `node:sqlite`, actualiza Node a
la 22.13 o posterior. Si no hay tal línea, no encontró la base de datos: está en
`~/.local/share/opencode/opencode.db`, o donde apunte `OPENCODE_DB` o
`XDG_DATA_HOME`.

**Una pestaña de OpenCode no abre: «Couldn't start the OpenCode server».** El
motivo viene después de los dos puntos. Si no queda claro, abre `opencode` en
una terminal común: si tampoco arranca ahí, el problema es esa instalación de
OpenCode.

**Una pestaña de OpenCode dice que el servidor se cerró.** **Relanzar**, en la
misma barra, arranca otro servidor y vuelve a conectar la pestaña a la misma
sesión.

**Una pestaña de Antigravity no muestra su estado ni el medidor.** Mira la
entrada `Status line` al arrancar la app, debajo de la CLI. Si dice que no está
configurada, o que hay otra, sigue
[estos pasos](#antigravity-cli-estado-y-medidor-de-contexto). Si la
configuraste y la terminal de la CLI muestra `Statusline Error`, lo más
probable es que `node` no esté en el `PATH` de esa sesión.

**`node-pty` no compila al instalar.** Es el módulo nativo de la terminal.
Normalmente descarga un binario ya hecho; si no hay uno para tu Node y tu
plataforma, hay que compilarlo:

- **Windows:** Visual Studio Build Tools con la carga de trabajo *Desarrollo
  para el escritorio con C++*, y Python 3. (`windows-build-tools` de npm ya no
  se mantiene.)
- **macOS:** `xcode-select --install`.
- **Linux:** `build-essential` y `python3`.

**La terminal queda en blanco.** El renderizador por defecto es canvas a
propósito: con WebGL, la pestaña se congela en Windows 11 + Chrome. Para probar
WebGL de todos modos, agrega `?renderer=webgl` a la dirección.

**Un cartel dice que se quitó `CLAUDE_CODE_CHILD_SESSION`.** Arrancaste la app
desde dentro de una sesión de Claude Code. Esa variable apaga el guardado del
historial, así que la app la quita y te avisa. Desde una terminal normal nunca
vas a ver esto.

**Desde el otro equipo, `ssh` no logra conectarse** (se agota el tiempo de
espera o la conexión es rechazada). El servidor SSH no está corriendo en el
equipo de la app, o algo entre los dos lo bloquea. En Windows, revisa que la red
wifi esté como *Privada*: puede que la regla del firewall del servidor SSH no
cubra las redes *Públicas*. Una VPN del trabajo que bloquea la red local también
lo corta mientras está conectada. Si `ssh` rechaza tu usuario, con una cuenta
de Microsoft o del trabajo puede hacer falta el nombre de tu carpeta de usuario
(`C:\Users\<name>`) y la contraseña de la cuenta, no el PIN.

**Desde el otro equipo, la página dice «Origen no permitido»** (403). Se abrió
con el nombre o la dirección IP del equipo. Abre `http://localhost:<port>`, con
el túnel usando el mismo puerto en los dos extremos.

**Desde el otro equipo, la página dice que falta el token de sesión** (401). Ese
navegador no está emparejado, fue revocado, o el acceso remoto está apagado.
Vuelve a emparejarlo desde el diálogo ⇄.

**El diálogo ⇄ dice que el puerto está ocupado.** Otro programa —a menudo un
segundo Agent Workbench— lo está usando. Ciérralo y reinicia, o elige otro
puerto.

**El panel Cambios dice que la carpeta no está dentro de un repositorio git**,
y sí lo está. Asegúrate de que `git` esté en el `PATH`. Si el mensaje es otro,
es el error de git tal cual, palabra por palabra.

---

## Desde el código fuente

Para trabajar en la app, o si prefieres no instalar nada de forma global:

```bash
corepack enable pnpm
pnpm install
pnpm dev       # con recarga en caliente
```

```bash
pnpm build     # compila la interfaz una vez
pnpm start     # sirve la interfaz compilada
```

**Arranque con un clic en Windows:** `pnpm package` compila la interfaz y deja
un **`Agent Workbench.cmd`** en la raíz. Ábrelo con doble clic: instala lo que
falte, compila si hace falta y abre el navegador. Es un archivo de texto de
veinte líneas que puedes leer antes de correrlo.

---

## Cómo está hecho

Un monorepo de pnpm, con TypeScript en todo.

```
packages/
  server/    Node, Express, ws, node-pty, chokidar — serves the interface and runs the terminals
    src/agents/   one adapter per CLI: the only part of the server that knows each one
  web/       Vite, React, xterm.js, highlight.js
  shared/    the protocol types, with no `any` at the edges
android/     the Android app, in Kotlin: the SSH tunnel, the interface, the notifications
```

Dos decisiones dan forma a todo lo demás. **Las terminales viven en el servidor
y el navegador es solo una ventana hacia ellas**: cerrar o recargar la página no
mata una sesión que está trabajando. Y **el servidor genérico no nombra ninguna
CLI**: lo que sabe de cada una —dónde guarda sus cosas, cómo se lanza, qué se
lee y qué no se abre nunca— vive en el adaptador de esa CLI, y la interfaz
muestra cada control según lo que esa CLI declara.

[`ARCHITECTURE.md`](ARCHITECTURE.md) tiene las reglas duras y el mapa del
código; [`CONTRIBUTING.md`](CONTRIBUTING.md), cómo trabajar en el repositorio;
[`SECURITY.md`](SECURITY.md), cómo reportar una vulnerabilidad;
[`PRIVACY.md`](PRIVACY.md), qué se recopila (nada), y
[`CHANGELOG.md`](CHANGELOG.md), qué cambió en cada versión (todos en inglés).
Los comentarios del código están en español. Las capturas de este README salen
de `pnpm demo:shots`, sobre datos inventados.

---

## Apoyar el proyecto

Si Agent Workbench te resulta útil, considera apoyarlo:
[Buy Me a Coffee](https://buymeacoffee.com/cvelasquez). La app lo sugiere una
vez por versión, en una franja que puedes cerrar, y no vuelve a hacerlo hasta la
siguiente.

---

## Licencia

MIT. Consulta [`LICENSE`](LICENSE).

Agent Workbench es un proyecto independiente. Funciona con las CLIs de
Claude Code, Codex, OpenCode, Antigravity y Pi, pero no está afiliado a
Anthropic, OpenAI, los autores de OpenCode, Google ni Earendil, ni cuenta con
su aval.
