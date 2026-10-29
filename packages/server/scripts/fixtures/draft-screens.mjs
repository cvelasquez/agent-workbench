// Pantallas de Claude Code 2.1.312 con la caja de escribir, leidas con el mismo
// emulador que la app (`@xterm/headless`) y sin el texto atenuado, como las lee
// `cli-draft.ts` (§5.3.1). Medidas el 28-10-2026 con
// `docs/herramientas/borrador-cli/medir-borrador.mjs`, en una pty de 110x40;
// cada una son las ultimas 10 filas, sin los espacios del final.
// Generado con `docs/herramientas/borrador-cli/fixtures.mjs`: no se edita a mano.

/** la caja vacia al arrancar, con la ayuda atenuada. */
export const PLACEHOLDER = [
  "",
  "",
  "",
  "",
  "                                                                                             ○ low · /effort",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 12m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
];

/** texto tecleado en la caja. */
export const TYPED = [
  "",
  "",
  "",
  "",
  "                                                                                             ○ low · /effort",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ Respuesta de prueba A: no hagas nada, responde ok.",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 12m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle)"
];

/** despues de Ctrl+S: la caja vacia y "› stashed". */
export const STASHED_EMPTY = [
  "",
  "",
  "",
  "",
  "                                                                                                   › stashed",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 12m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
];

/** despues de enviar: el texto de vuelta ("Draft restored"). */
export const RESTORED = [
  "",
  "",
  "",
  "",
  "                                                                                              Draft restored",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ borrador D: no hagas nada, responde ok",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 12m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle)"
];

/** el agente trabajando, con el texto de vuelta en la caja. */
export const RESTORED_BUSY = [
  "",
  "",
  "",
  "✢ Hashing…",
  "                                                                                              Draft restored",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ borrador D: no hagas nada, responde ok",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 12m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle)"
];

/** el agente trabajando, despues de Ctrl+S. */
export const STASHED_BUSY = [
  "",
  "",
  "",
  "✢ Hashing…",
  "                                                                                  Draft restored · › stashed",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 12m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
];

/** texto en la caja y otro ya apartado. */
export const TEXT_AND_SAVED = [
  "",
  "● ok",
  "",
  "✻ Churned for 2s · done 5:28 p.m.",
  "                                                                                  Draft restored · › stashed",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ borrador I",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 11m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle)"
];

/** un pegado largo en la caja. */
export const PASTED = [
  "",
  "● ok",
  "",
  "✻ Churned for 2s · done 5:28 p.m.",
  "                                                                                Ctrl+Y to paste deleted text",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ [Pasted text #1 +5 lines]",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 11m) · week 10% (4d 17h)",
  "  paste again to expand"
];

/** La de `PLACEHOLDER` tal cual, con la ayuda atenuada: lo que veria un lector sin atributos. */
export const PLACEHOLDER_WITH_FAINT = [
  "",
  "",
  "",
  "",
  "                                                                                             ○ low · /effort  ",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ Try \"how do I log an error?\"",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  5h 7% (2h 12m) · week 10% (4d 17h)",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent"
];
