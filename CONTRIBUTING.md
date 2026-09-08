# Contribuir a Agent Workbench

Gracias por mirar el proyecto. Es una herramienta chica y personal, así que las
reglas también son pocas. Las que hay, sin embargo, no son negociables: casi
todas existen porque algo salió mal una vez.

---

## Antes de escribir código

Leé [`CLAUDE.md`](CLAUDE.md). No es documentación de cortesía: tiene las reglas
duras del proyecto y el detalle de las trampas ya pisadas (el esquema real del
JSONL, por qué `kill('SIGTERM')` tumbaba el servidor en Windows, por qué el
renderer WebGL está apagado). Un cambio que las ignora se descarta aunque
funcione.

---

## Las cuatro reglas que no se discuten

1. **La aplicación no toca credenciales.** No se lee, copia ni reenvía
   `~/.claude/.credentials.json` ni ningún token. No hay login en la interfaz.
   No se inyectan `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` ni
   `CLAUDE_CODE_OAUTH_TOKEN` en el entorno de los procesos que se lanzan.

2. **El binario de la CLI va sin modificar y sin empaquetar.** Se busca en el
   `PATH`. No se incluye en el repositorio, no se descarga y no se envuelve de
   forma que altere su comportamiento.

3. **El servidor escucha solo en `127.0.0.1`**, con puerto efímero y un token
   aleatorio por arranque que exigen tanto el WebSocket como todas las rutas
   HTTP. Sin telemetría y sin ninguna llamada de red saliente.

4. **La marca.** El producto se llama Agent Workbench. Ni el nombre, ni el logo,
   ni ninguna funcionalidad llevan "Claude", "Claude Code" ni "Anthropic". En el
   código, identificadores neutros (`agentCli`, `cliBinary`, `sessionIndex`).
   El README puede decir en texto plano que funciona con la CLI de Claude Code:
   es compatibilidad, no respaldo.

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
tu historial ni tu configuración: un home falso, una CLI simulada primera en el
`PATH` y, en Windows, una unidad `W:` montada con `subst` para que ninguna ruta
lleve tu usuario. Sirve para trabajar en la interfaz con datos estables y para
verla sin exponer nada propio.

`pnpm demo:shots` (después de `pnpm build`) saca las capturas del README con
ese mismo entorno y el Chrome que tengas instalado. **Las capturas del repo
salen de ahí y de ningún otro lado**: son públicas, y una captura de tu
instalación real muestra los nombres de tus proyectos. Si cambiás la interfaz,
volvé a generarlas con ese comando en vez de reemplazarlas a mano.

---

## Qué encaja y qué no

**Encaja:** arreglos de compatibilidad entre plataformas, casos del esquema del
JSONL que cambian entre versiones de la CLI, accesibilidad, rendimiento con
repositorios o historiales grandes.

**No encaja:** operaciones de git que escriben (commit, stage, push) desde la
interfaz —hay un agente editando archivos y la terminal es donde el comando se
ve antes de ejecutarse—, cualquier forma de autenticación dentro de la app, y
opciones de configuración que se puedan evitar con un buen valor por defecto.
La aplicación tiene que ser entendible sin manual: el esfuerzo mental del
usuario va en su proyecto, no en nuestra herramienta.
