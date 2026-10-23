// Pantallas de Claude Code 2.1.309 con el menu de AskUserQuestion abierto, leidas
// con el mismo emulador que la app (`@xterm/headless`, como `pty-screen.ts`).
// Medidas el 23-10-2026 con `docs/herramientas/claude-preguntas/medir.mjs`, en
// una pty como la de la app (§5.5.4). Cada una va desde un poco antes del menu
// hasta el final de la pantalla, sin los espacios del final de cada linea.
// `INPUTS` es el input real que la CLI recibio, leido del historial al contestar.
// Generado: no se edita a mano.

/** tres opciones con descripcion, 110x34 (110x34). */
export const BASIC_OPEN = [
  "  usa el resto del sistema.\"},{\"label\":\"SQLite\",\"description\":\"Un archivo local, sin",
  "  servidor.\"},{\"label\":\"DuckDB\",\"description\":\"Columnar, rápida para análisis.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Base",
  "",
  "¿Qué base de datos usamos para el módulo de reportes?",
  "",
  "❯ 1. PostgreSQL",
  "     La que ya usa el resto del sistema.",
  "  2. SQLite",
  "     Un archivo local, sin servidor.",
  "  3. DuckDB",
  "     Columnar, rápida para análisis.",
  "  4. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
  "",
  "",
  "",
  "",
  "",
  "",
];

/** la misma, con la marca en la segunda (flecha abajo) (110x34). */
export const BASIC_CURSOR_MOVED = [
  "  usa el resto del sistema.\"},{\"label\":\"SQLite\",\"description\":\"Un archivo local, sin",
  "  servidor.\"},{\"label\":\"DuckDB\",\"description\":\"Columnar, rápida para análisis.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Base",
  "",
  "¿Qué base de datos usamos para el módulo de reportes?",
  "",
  "  1. PostgreSQL",
  "     La que ya usa el resto del sistema.",
  "❯ 2. SQLite",
  "     Un archivo local, sin servidor.",
  "  3. DuckDB",
  "     Columnar, rápida para análisis.",
  "  4. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
  "",
  "",
  "",
  "",
  "",
  "",
];

/** despues de contestarla con el 3: ya no hay menu (110x34). */
export const BASIC_ANSWERED = [
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "✢ Topsy-turvying… (5s · ↓ 322 tokens)",
  "                                                                                          ◐ medium · /effort",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 1% (4h 0m) · week 1% (6d 0h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
];

/** dos opciones, el pie en la ultima fila (110x34). */
export const TWO_OPTIONS = [
  "  temporales?\",\"header\":\"Limpiar\",\"multiSelect\":false,\"options\":[{\"label\":\"Sí\",\"description\":\"Se borran",
  "  ahora.\"},{\"label\":\"No\",\"description\":\"Se dejan como están.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Limpiar",
  "",
  "¿Borro los archivos temporales?",
  "",
  "❯ 1. Sí",
  "     Se borran ahora.",
  "  2. No",
  "     Se dejan como están.",
  "  3. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** pregunta larga (con la barra) y cuatro opciones de descripcion larga (110x34). */
export const LONG_OPEN = [
  "  cuando el área de ventas confirme qué tableros siguen vivos y cuáles se pueden apagar sin avisar a nadie",
  "  más.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Migración",
  "",
  "│ Antes de seguir con la migración necesito saber cómo quieres manejar los datos viejos del módulo de",
  "│ reportes, porque hay tablas que ya no se usan desde la versión 2 y otras que todavía alimentan los tableros",
  "│ del área de ventas; según lo que elijas cambia el orden de los pasos y cuánto tiempo va a estar el sistema",
  "│ en mantenimiento esta noche.",
  "",
  "❯ 1. Migrar todo y archivar lo viejo",
  "     Se copian todas las tablas al esquema nuevo, incluidas las que ya no se usan, y las viejas quedan",
  "     archivadas en un respaldo comprimido por si alguien las necesita después; es lo más seguro pero también",
  "     lo más lento.",
  "  2. Migrar solo lo que se usa",
  "     Se copian únicamente las tablas que hoy alimentan algún tablero o proceso, y las demás se borran después",
  "     de un respaldo; tarda la mitad pero hay que confirmar la lista antes de empezar.",
  "  3. Dejar los datos viejos donde están",
  "     No se toca nada de lo viejo: el esquema nuevo convive con el anterior y los tableros siguen leyendo de",
  "     ahí hasta que alguien decida otra cosa.",
  "  4. Posponer la migración",
  "     Se deja todo como está esta noche y se agenda otra ventana de mantenimiento cuando el área de ventas",
  "     confirme qué tableros siguen vivos y cuáles se pueden apagar sin avisar a nadie más.",
  "  5. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  6. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** la misma al achicar la terminal a 60x20: redibujo a medias (60x20). */
export const LONG_RESIZED = [
  "  siguen leyendo de ahí hasta que alguien decida otra cosa.\" necesita después; es lo más seguro pero también",
  "  migración\",\"description\":\"Se deja todo como está esta noch",
  "  cuando el área de ventas confirme qué tableros siguen vivo",
  "  más.\"}]}]}                                                 tablero o proceso, y las demás se borran después",
  "────────────────────────────────────────────────────────────a lista antes de empezar.",
  " ☐ Migración",
  "                                                            on el anterior y los tableros siguen leyendo de",
  "│ Antes de seguir con la migración necesito saber cómo quier",
  "│ reportes, porque hay tablas que ya no se usan desde la ver",
  "│ del área de ventas; según lo que elijas cambia el orden deana de mantenimiento cuando el área de ventas",
  "│ en mantenimiento esta noche.                              pagar sin avisar a nadie más.",
  "",
  "❯ 1. Migrar todo y archivar lo viejo                        ──────────────────────────────────────────────────",
  "     Se copian todas las tablas al esquema nuevo, incluidas",
  "     archivadas en un respaldo comprimido por si alguien las",
  "     lo más lento.",
];

/** con el 5: la marca en "Type something" y el pie con ctrl+g (110x34). */
export const LONG_WRITING = [
  "  cuando el área de ventas confirme qué tableros siguen vivos y cuáles se pueden apagar sin avisar a nadie",
  "  más.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Migración",
  "",
  "│ Antes de seguir con la migración necesito saber cómo quieres manejar los datos viejos del módulo de",
  "│ reportes, porque hay tablas que ya no se usan desde la versión 2 y otras que todavía alimentan los tableros",
  "│ del área de ventas; según lo que elijas cambia el orden de los pasos y cuánto tiempo va a estar el sistema",
  "│ en mantenimiento esta noche.",
  "",
  "  1. Migrar todo y archivar lo viejo",
  "     Se copian todas las tablas al esquema nuevo, incluidas las que ya no se usan, y las viejas quedan",
  "     archivadas en un respaldo comprimido por si alguien las necesita después; es lo más seguro pero también",
  "     lo más lento.",
  "  2. Migrar solo lo que se usa",
  "     Se copian únicamente las tablas que hoy alimentan algún tablero o proceso, y las demás se borran después",
  "     de un respaldo; tarda la mitad pero hay que confirmar la lista antes de empezar.",
  "  3. Dejar los datos viejos donde están",
  "     No se toca nada de lo viejo: el esquema nuevo convive con el anterior y los tableros siguen leyendo de",
  "     ahí hasta que alguien decida otra cosa.",
  "  4. Posponer la migración",
  "     Se deja todo como está esta noche y se agenda otra ventana de mantenimiento cuando el área de ventas",
  "     confirme qué tableros siguen vivos y cuáles se pueden apagar sin avisar a nadie más.",
  "❯ 5. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  6. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel",
];

/** opcion multiple, recien abierta (110x34). */
export const MULTI_OPEN = [
  "  Node.\"},{\"label\":\"Web\",\"description\":\"La interfaz en React.\"},{\"label\":\"Android\",\"description\":\"La app del",
  "  teléfono.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☐ Revisión  ✔ Submit  →",
  "",
  "¿Qué partes reviso?",
  "",
  "❯ 1. [ ] Servidor",
  "         El código de Node.",
  "  2. [ ] Web",
  "         La interfaz en React.",
  "  3. [ ] Android",
  "         La app del teléfono.",
  "  4. [ ] Type something",
  "     Submit",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** opcion multiple con la primera marcada (110x34). */
export const MULTI_CHECKED = [
  "  Node.\"},{\"label\":\"Web\",\"description\":\"La interfaz en React.\"},{\"label\":\"Android\",\"description\":\"La app del",
  "  teléfono.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☒ Revisión  ✔ Submit  →",
  "",
  "¿Qué partes reviso?",
  "",
  "❯ 1. [✔] Servidor",
  "         El código de Node.",
  "  2. [ ] Web",
  "         La interfaz en React.",
  "  3. [ ] Android",
  "         La app del teléfono.",
  "  4. [ ] Type something",
  "     Submit",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** opcion multiple despues del Tab: la pantalla de enviar (110x34). */
export const MULTI_REVIEW = [
  "  teléfono.\"}]}]}",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☒ Revisión  ✔ Submit  →",
  "",
  "Review your answers",
  "",
  " ● ¿Qué partes reviso?",
  "   → Servidor, Android",
  "",
  "Ready to submit your answers?",
  "",
  "❯ 1. Submit answers",
  "  2. Cancel",
  "",
  "",
  "",
  "",
];

/** dos preguntas en una llamada (110x34). */
export const TWO_QUESTIONS = [
  "  pruebas?\",\"header\":\"Pruebas\",\"multiSelect\":false,\"options\":[{\"label\":\"Vitest\",\"description\":\"Rápido,",
  "  compatible con Vite.\"},{\"label\":\"Jest\",\"description\":\"El clásico.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "←  ☐ Lenguaje  ☐ Pruebas  ✔ Submit  →",
  "",
  "¿Qué lenguaje usamos?",
  "",
  "❯ 1. TypeScript",
  "     Tipado estático.",
  "  2. Python",
  "     Rápido de escribir.",
  "  3. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

/** opciones con vista previa (110x34). */
export const PREVIEW = [
  "  columnas.\",\"preview\":\"┌───┬───┐\\n│ a │ b │\\n└───┴───┘\"}]}]}",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Diseño",
  "",
  "¿Qué diseño prefieres para la lista?",
  "",
  "❯ 1. Lista                        ┌──────────────────────────────────────────┐",
  "  2. Grilla                       │ ┌──────┐                                 │",
  "                                  │ │ item │                                 │",
  "                                  │ │ item │                                 │",
  "                                  │ └──────┘                                 │",
  "                                  └──────────────────────────────────────────┘",
  "",
  "                                  Notes: press n to add notes",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
];

/** la basica en 45 columnas: pregunta y pie partidos (45x30). */
export const NARROW = [
  "  DuckDB\",\"description\":\"Columnar, rápida",
  "  para análisis.\"}]}]}",
  "─────────────────────────────────────────────",
  " ☐ Base",
  "",
  "¿Qué base de datos usamos para el módulo de",
  "reportes?",
  "",
  "❯ 1. PostgreSQL",
  "     La que ya usa el resto del sistema.",
  "  2. SQLite",
  "     Un archivo local, sin servidor.",
  "  3. DuckDB",
  "     Columnar, rápida para análisis.",
  "  4. Type something.",
  "─────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to",
  "cancel",
];

/** la larga en 14 filas: la lista recortada (110x14). */
export const SHORT = [
  "❯ 1. Migrar todo y archivar lo viejo",
  "     Se copian todas las tablas al esquema nuevo, incluidas las que ya no se usan, y las viejas quedan",
  "     archivadas en un respaldo comprimido por si alguien las necesita después; es lo más seguro pero también",
  "     lo más lento.",
  "  2. Migrar solo lo que se usa",
  "     Se copian únicamente las tablas que hoy alimentan algún tablero o proceso, y las demás se borran después",
  "     de un respaldo; tarda la mitad pero hay que confirmar la lista antes de empezar.",
  "↓ 3. Dejar los datos viejos donde están",
  "     No se toca nada de lo viejo: el esquema nuevo convive con el anterior y los tableros siguen leyendo de",
  "     ahí hasta que alguien decida otra cosa.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  6. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** markdown sin dibujar, etiqueta "1. Instalar" y descripcion "2. Despues..." (110x34). */
export const MARKDOWN = [
  "  build.\"},{\"label\":\"Compilar 2 veces\",\"description\":\"Primero typecheck, luego",
  "  build.\"},{\"label\":\"Nada\",\"description\":\"Esperar.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Primer paso",
  "",
  "¿Cuál de estos **pasos** hago primero con `pnpm`?",
  "",
  "❯ 1. 1. Instalar",
  "     2. Después, compilar con `pnpm build`.",
  "  2. Compilar 2 veces",
  "     **Primero** typecheck, luego build.",
  "  3. Nada",
  "     Esperar.",
  "  4. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
  "",
  "",
  "",
  "",
  "",
  "",
];

/** una pregunta de 150 letras: dos lineas con la barra (110x34). */
export const MEDIUM_OPEN = [
  "  error?\",\"header\":\"Registros\",\"multiSelect\":false,\"options\":[{\"label\":\"Dejarlos\",\"description\":\"Hasta el",
  "  viernes.\"},{\"label\":\"Apagarlos\",\"description\":\"Apenas termine.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Registros",
  "",
  "│ ¿Quieres que deje los registros de depuración activados en el servidor de pruebas hasta el viernes, o los",
  "│ apago apenas termine de revisar el error?",
  "",
  "❯ 1. Dejarlos",
  "     Hasta el viernes.",
  "  2. Apagarlos",
  "     Apenas termine.",
  "  3. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** con la marca en "Type something" por flechas (110x34). */
export const MEDIUM_ON_WRITE = [
  "  error?\",\"header\":\"Registros\",\"multiSelect\":false,\"options\":[{\"label\":\"Dejarlos\",\"description\":\"Hasta el",
  "  viernes.\"},{\"label\":\"Apagarlos\",\"description\":\"Apenas termine.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Registros",
  "",
  "│ ¿Quieres que deje los registros de depuración activados en el servidor de pruebas hasta el viernes, o los",
  "│ apago apenas termine de revisar el error?",
  "",
  "  1. Dejarlos",
  "     Hasta el viernes.",
  "  2. Apagarlos",
  "     Apenas termine.",
  "❯ 3. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel",
];

/** con "abc" escrito en la respuesta propia (110x34). */
export const MEDIUM_TYPED = [
  "  error?\",\"header\":\"Registros\",\"multiSelect\":false,\"options\":[{\"label\":\"Dejarlos\",\"description\":\"Hasta el",
  "  viernes.\"},{\"label\":\"Apagarlos\",\"description\":\"Apenas termine.\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Registros",
  "",
  "│ ¿Quieres que deje los registros de depuración activados en el servidor de pruebas hasta el viernes, o los",
  "│ apago apenas termine de revisar el error?",
  "",
  "  1. Dejarlos",
  "     Hasta el viernes.",
  "  2. Apagarlos",
  "     Apenas termine.",
  "❯ 3. abc",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel",
];

/** una pregunta con un salto de linea y opciones sin descripcion (110x34). */
export const NEWLINE = [
  "  global el 8080. ¿Cuál dejo?\",\"header\":\"Puerto\",\"multiSelect\":false,\"options\":[{\"label\":\"3000\",\"description",
  "  \":\"\"},{\"label\":\"8080\",\"description\":\"\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Puerto",
  "",
  "│ Encontré dos configuraciones distintas.",
  "│ La del proyecto usa el puerto 3000 y la global el 8080. ¿Cuál dejo?",
  "",
  "❯ 1. 3000",
  "  2. 8080",
  "  3. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** etiquetas largas en 45 columnas: la etiqueta se parte (45x34). */
export const NARROW_LONG_LABELS = [
  "  borrarla\",\"description\":\"Se puede",
  "  volver.\"}]}]}",
  "─────────────────────────────────────────────",
  " ☐ Rama",
  "",
  "¿Qué hago con la rama vieja?",
  "",
  "❯ 1. Borrarla del remoto y también de la",
  "     copia local",
  "     No queda nada.",
  "  2. Archivarla con una etiqueta antes de",
  "     borrarla",
  "     Se puede volver.",
  "  3. Type something.",
  "─────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to",
  "cancel",
];

/** cuatro opciones en 110x24 (110x24). */
export const FOUR_OPTIONS = [
  "  :\"Latina\",\"description\":\"23-10-2026\"},{\"label\":\"Larga\",\"description\":\"23 de octubre de",
  "  2026\"},{\"label\":\"Relativa\",\"description\":\"hace 2 días\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Fecha",
  "",
  "¿Qué formato uso para la fecha?",
  "",
  "❯ 1. ISO",
  "     2026-10-23",
  "  2. Latina",
  "     23-10-2026",
  "  3. Larga",
  "     23 de octubre de 2026",
  "  4. Relativa",
  "     hace 2 días",
  "  5. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  6. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** con la marca en "Chat about this" (110x24). */
export const FOUR_ON_CHAT = [
  "  :\"Latina\",\"description\":\"23-10-2026\"},{\"label\":\"Larga\",\"description\":\"23 de octubre de",
  "  2026\"},{\"label\":\"Relativa\",\"description\":\"hace 2 días\"}]}]}",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " ☐ Fecha",
  "",
  "¿Qué formato uso para la fecha?",
  "",
  "  1. ISO",
  "     2026-10-23",
  "  2. Latina",
  "     23-10-2026",
  "  3. Larga",
  "     23 de octubre de 2026",
  "  4. Relativa",
  "     hace 2 días",
  "  5. Type something.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ 6. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel",
];

/** El input de cada pregunta, como lo escribio la CLI en el historial. */
export const INPUTS = {
  "q1-basica": {
    "questions": [
      {
        "question": "¿Qué base de datos usamos para el módulo de reportes?",
        "header": "Base",
        "multiSelect": false,
        "options": [
          {
            "label": "PostgreSQL",
            "description": "La que ya usa el resto del sistema."
          },
          {
            "label": "SQLite",
            "description": "Un archivo local, sin servidor."
          },
          {
            "label": "DuckDB",
            "description": "Columnar, rápida para análisis."
          }
        ]
      }
    ]
  },
  "q2-cancelar": {
    "questions": [
      {
        "question": "¿Borro los archivos temporales?",
        "header": "Limpiar",
        "multiSelect": false,
        "options": [
          {
            "label": "Sí",
            "description": "Se borran ahora."
          },
          {
            "label": "No",
            "description": "Se dejan como están."
          }
        ]
      }
    ]
  },
  "q3-larga": {
    "questions": [
      {
        "question": "Antes de seguir con la migración necesito saber cómo quieres manejar los datos viejos del módulo de reportes, porque hay tablas que ya no se usan desde la versión 2 y otras que todavía alimentan los tableros del área de ventas; según lo que elijas cambia el orden de los pasos y cuánto tiempo va a estar el sistema en mantenimiento esta noche.",
        "header": "Migración",
        "multiSelect": false,
        "options": [
          {
            "label": "Migrar todo y archivar lo viejo",
            "description": "Se copian todas las tablas al esquema nuevo, incluidas las que ya no se usan, y las viejas quedan archivadas en un respaldo comprimido por si alguien las necesita después; es lo más seguro pero también lo más lento."
          },
          {
            "label": "Migrar solo lo que se usa",
            "description": "Se copian únicamente las tablas que hoy alimentan algún tablero o proceso, y las demás se borran después de un respaldo; tarda la mitad pero hay que confirmar la lista antes de empezar."
          },
          {
            "label": "Dejar los datos viejos donde están",
            "description": "No se toca nada de lo viejo: el esquema nuevo convive con el anterior y los tableros siguen leyendo de ahí hasta que alguien decida otra cosa."
          },
          {
            "label": "Posponer la migración",
            "description": "Se deja todo como está esta noche y se agenda otra ventana de mantenimiento cuando el área de ventas confirme qué tableros siguen vivos y cuáles se pueden apagar sin avisar a nadie más."
          }
        ]
      }
    ]
  },
  "q4-multiple": {
    "questions": [
      {
        "question": "¿Qué partes reviso?",
        "header": "Revisión",
        "multiSelect": true,
        "options": [
          {
            "label": "Servidor",
            "description": "El código de Node."
          },
          {
            "label": "Web",
            "description": "La interfaz en React."
          },
          {
            "label": "Android",
            "description": "La app del teléfono."
          }
        ]
      }
    ]
  },
  "q5-dos-preguntas": {
    "questions": [
      {
        "question": "¿Qué lenguaje usamos?",
        "header": "Lenguaje",
        "multiSelect": false,
        "options": [
          {
            "label": "TypeScript",
            "description": "Tipado estático."
          },
          {
            "label": "Python",
            "description": "Rápido de escribir."
          }
        ]
      },
      {
        "question": "¿Qué framework de pruebas?",
        "header": "Pruebas",
        "multiSelect": false,
        "options": [
          {
            "label": "Vitest",
            "description": "Rápido, compatible con Vite."
          },
          {
            "label": "Jest",
            "description": "El clásico."
          }
        ]
      }
    ]
  },
  "q6-preview": {
    "questions": [
      {
        "question": "¿Qué diseño prefieres para la lista?",
        "header": "Diseño",
        "multiSelect": false,
        "options": [
          {
            "label": "Lista",
            "description": "Una columna.",
            "preview": "┌──────┐\n│ item │\n│ item │\n└──────┘"
          },
          {
            "label": "Grilla",
            "description": "Dos columnas.",
            "preview": "┌───┬───┐\n│ a │ b │\n└───┴───┘"
          }
        ]
      }
    ]
  },
  "q8-angosta": {
    "questions": [
      {
        "question": "¿Qué base de datos usamos para el módulo de reportes?",
        "header": "Base",
        "multiSelect": false,
        "options": [
          {
            "label": "PostgreSQL",
            "description": "La que ya usa el resto del sistema."
          },
          {
            "label": "SQLite",
            "description": "Un archivo local, sin servidor."
          },
          {
            "label": "DuckDB",
            "description": "Columnar, rápida para análisis."
          }
        ]
      }
    ]
  },
  "q9-baja": {
    "questions": [
      {
        "question": "Antes de seguir con la migración necesito saber cómo quieres manejar los datos viejos del módulo de reportes, porque hay tablas que ya no se usan desde la versión 2 y otras que todavía alimentan los tableros del área de ventas; según lo que elijas cambia el orden de los pasos y cuánto tiempo va a estar el sistema en mantenimiento esta noche.",
        "header": "Migración",
        "multiSelect": false,
        "options": [
          {
            "label": "Migrar todo y archivar lo viejo",
            "description": "Se copian todas las tablas al esquema nuevo, incluidas las que ya no se usan, y las viejas quedan archivadas en un respaldo comprimido por si alguien las necesita después; es lo más seguro pero también lo más lento."
          },
          {
            "label": "Migrar solo lo que se usa",
            "description": "Se copian únicamente las tablas que hoy alimentan algún tablero o proceso, y las demás se borran después de un respaldo; tarda la mitad pero hay que confirmar la lista antes de empezar."
          },
          {
            "label": "Dejar los datos viejos donde están",
            "description": "No se toca nada de lo viejo: el esquema nuevo convive con el anterior y los tableros siguen leyendo de ahí hasta que alguien decida otra cosa."
          },
          {
            "label": "Posponer la migración",
            "description": "Se deja todo como está esta noche y se agenda otra ventana de mantenimiento cuando el área de ventas confirme qué tableros siguen vivos y cuáles se pueden apagar sin avisar a nadie más."
          }
        ]
      }
    ]
  },
  "r1-markdown": {
    "questions": [
      {
        "question": "¿Cuál de estos **pasos** hago primero con `pnpm`?",
        "header": "Primer paso",
        "multiSelect": false,
        "options": [
          {
            "label": "1. Instalar",
            "description": "2. Después, compilar con `pnpm build`."
          },
          {
            "label": "Compilar 2 veces",
            "description": "**Primero** typecheck, luego build."
          },
          {
            "label": "Nada",
            "description": "Esperar."
          }
        ]
      }
    ]
  },
  "r3-mediana": {
    "questions": [
      {
        "question": "¿Quieres que deje los registros de depuración activados en el servidor de pruebas hasta el viernes, o los apago apenas termine de revisar el error?",
        "header": "Registros",
        "multiSelect": false,
        "options": [
          {
            "label": "Dejarlos",
            "description": "Hasta el viernes."
          },
          {
            "label": "Apagarlos",
            "description": "Apenas termine."
          }
        ]
      }
    ]
  },
  "r4-dos-parrafos": {
    "questions": [
      {
        "question": "Encontré dos configuraciones distintas.\nLa del proyecto usa el puerto 3000 y la global el 8080. ¿Cuál dejo?",
        "header": "Puerto",
        "multiSelect": false,
        "options": [
          {
            "label": "3000",
            "description": ""
          },
          {
            "label": "8080",
            "description": ""
          }
        ]
      }
    ]
  },
  "r5-etiqueta-larga": {
    "questions": [
      {
        "question": "¿Qué hago con la rama vieja?",
        "header": "Rama",
        "multiSelect": false,
        "options": [
          {
            "label": "Borrarla del remoto y también de la copia local",
            "description": "No queda nada."
          },
          {
            "label": "Archivarla con una etiqueta antes de borrarla",
            "description": "Se puede volver."
          }
        ]
      }
    ]
  },
  "r6-cuatro-cortas": {
    "questions": [
      {
        "question": "¿Qué formato uso para la fecha?",
        "header": "Fecha",
        "multiSelect": false,
        "options": [
          {
            "label": "ISO",
            "description": "2026-10-23"
          },
          {
            "label": "Latina",
            "description": "23-10-2026"
          },
          {
            "label": "Larga",
            "description": "23 de octubre de 2026"
          },
          {
            "label": "Relativa",
            "description": "hace 2 días"
          }
        ]
      }
    ]
  }
};
