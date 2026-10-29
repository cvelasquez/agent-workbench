// Pantallas de Claude Code 2.1.312 con su caja, medidas el 28-10-2026 con
// `docs/herramientas/borrador-cli/medir-sugerencia.mjs` (Sonnet, con la
// sugerencia encendida en el proceso de prueba), en una pty de 110x40. Cada una
// son las ultimas 10 filas, partidas como las lee `cli-suggestions.ts`:
// `clean` sin lo atenuado y `faint` solo lo atenuado, cada caracter en su columna.
// Generado con `docs/herramientas/borrador-cli/fixtures-sugerencia.mjs`: no se edita a mano.

/** al arrancar: la ayuda atenuada de una sesion nueva. */
export const START = {
  "clean": [
    "",
    "",
    "",
    "",
    "                                                                                          ◐ medium · /effort",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
  ],
  "faint": [
    "",
    "",
    "",
    "",
    "",
    "",
    "  Try \"how do I log an error?\"",
    "",
    "",
    ""
  ]
};

/** despues del primer turno: la caja vacia, sin nada en gris. */
export const AFTER_FIRST_TURN = {
  "clean": [
    "",
    "",
    "",
    "",
    "",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  5h 1% (4h 26m) · week 11% (4d 14h)",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
  ],
  "faint": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
  ]
};

/** la sugerencia, en gris en la caja vacia. */
export const SUGGESTION = {
  "clean": [
    "  Instalá las dependencias con `npm install` y verificá con `npm test`.",
    "",
    "✻ Churned for 2s · done 8:14 p.m.",
    "",
    "",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  5h 1% (4h 25m) · week 11% (4d 14h)",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
  ],
  "faint": [
    "",
    "",
    "",
    "",
    "",
    "",
    "  Respuesta de prueba: ahora agregá una sección de uso",
    "",
    "",
    ""
  ]
};

/** una letra tecleada encima: la tapa. */
export const TYPED_OVER = {
  "clean": [
    "  Instalá las dependencias con `npm install` y verificá con `npm test`.",
    "",
    "✻ Churned for 2s · done 8:14 p.m.",
    "",
    "",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯ x",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  5h 1% (4h 25m) · week 11% (4d 14h)",
    "  ⏵⏵ auto mode on (shift+tab to cycle)"
  ],
  "faint": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
  ]
};

/** algo pegado encima: tambien la tapa. */
export const PASTED_OVER = {
  "clean": [
    "  Instalá las dependencias con `npm install` y verificá con `npm test`.",
    "",
    "✻ Churned for 2s · done 8:14 p.m.",
    "",
    "",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯ pegado",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  5h 1% (4h 25m) · week 11% (4d 14h)",
    "  ⏵⏵ auto mode on (shift+tab to cycle)"
  ],
  "faint": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
  ]
};

/** despues de Tab: ya es texto escrito, no gris. */
export const TAKEN_WITH_TAB = {
  "clean": [
    "  Instalá las dependencias con `npm install` y verificá con `npm test`.",
    "",
    "✻ Churned for 2s · done 8:14 p.m.",
    "",
    "",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯ Respuesta de prueba: ahora agregá una sección de uso",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  5h 1% (4h 25m) · week 11% (4d 14h)",
    "  ⏵⏵ auto mode on (shift+tab to cycle)"
  ],
  "faint": [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
  ]
};

/** la caja vaciada otra vez: la sugerencia vuelve. */
export const CLEARED_AGAIN = {
  "clean": [
    "  Instalá las dependencias con `npm install` y verificá con `npm test`.",
    "",
    "✻ Churned for 2s · done 8:14 p.m.",
    "",
    "                                                                                Ctrl+Y to paste deleted text",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  5h 1% (4h 25m) · week 11% (4d 14h)",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
  ],
  "faint": [
    "",
    "",
    "",
    "",
    "",
    "",
    "  Respuesta de prueba: ahora agregá una sección de uso",
    "",
    "",
    ""
  ]
};
