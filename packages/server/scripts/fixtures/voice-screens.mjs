// Pantallas de Claude Code 2.1.318 y Antigravity CLI 1.5.x con la caja de escribir y lo que dibujan al
// dictar, leidas con el mismo emulador que la app (`createPtyScreen`, pty de 120x38) y sin el texto
// atenuado. Medidas el 06-11-2026 con `docs/herramientas/voice-dictation/medir-caja.mjs` (sin hablar:
// el texto largo es lo que se tecleo en la caja, que es lo mismo que la CLI deja al insertar un
// dictado). Cada una es la zona de la caja: desde la linea de arriba de su primera regla.
// Generado con `docs/herramientas/voice-dictation/fixtures.mjs`: no se edita a mano.

export const CLAUDE_LISTENING = [
  "                                                                                                            listening…",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ▅",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent"
];

export const CLAUDE_PROCESSING = [
  "                                                                                                    Voice: processing…",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent"
];

export const CLAUDE_NO_SPEECH = [
  "                                                                                                   No speech detected.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent"
];

export const CLAUDE_HOLDING = [
  "                                                                                          Ctrl+Y to paste deleted text",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · keep holding…"
];

export const CLAUDE_TYPED = [
  "                                                                                                       ○ low · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ Hola, esto es una prueba de dictado para ver como la caja parte las lineas cuando el texto es largo y llega hasta el",
  "  final del ancho disponible, y todavia sigue un poco mas.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle)"
];

export const CLAUDE_CLEARED = [
  "                                                                                          Ctrl+Y to paste deleted text",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · ← 1 agent · hold space to speak"
];

export const CLAUDE_EMPTY = [
  "                                                                                                       ○ low · /effort",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ plan mode on (shift+tab to cycle) · ← for agents · hold space to speak"
];

export const AGY_HINT_PLAN = [
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> Plan mode: research & plan only (shift+tab to cycle)",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                      plan · Gemini 3.8 Flash · high · AI: Out of credits"
];

export const AGY_HINT_ACCEPT_EDITS = [
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> Accept-edits mode: file edits auto-approved (shift+tab to cycle)",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts"
];

export const AGY_HINT_AUTO = [
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts"
];

export const AGY_TYPED = [
  " ┃ esc to dismiss",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> Hola, esto es una prueba de dictado para ver como la caja parte las lineas cuando el texto es largo y llega hasta el",
  "  final del ancho disponible, y todavia sigue un poco mas.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "                                                                     plan · Gemini 3.8 Flash · high · AI: Out of credits"
];

export const AGY_CLEARED = [
  " ┃ esc to dismiss",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                      plan · Gemini 3.8 Flash · high · AI: Out of credits"
];

export const AGY_CONNECTING = [
  " ┃ esc to dismiss",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  Connecting... esc to cancel",
  "? for shortcuts                                                      plan · Gemini 3.8 Flash · high · AI: Out of credits"
];

export const AGY_RECORDING = [
  " ┃ esc to dismiss",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "● Recording 00:01  enter or f5 to insert · esc to discard",
  "? for shortcuts                                                      plan · Gemini 3.8 Flash · high · AI: Out of credits"
];

export const AGY_FINISHING = [
  " ┃ esc to dismiss",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  Finishing up... enter or f5 to insert what you have · esc to discard",
  "? for shortcuts                                                      plan · Gemini 3.8 Flash · high · AI: Out of credits"
];

export const AGY_DONE_EMPTY = [
  " ┃ esc to dismiss",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                      plan · Gemini 3.8 Flash · high · AI: Out of credits"
];
