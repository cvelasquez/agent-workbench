/**
 * Lo que el cuadro de escritura hace con la voz de la CLI (06-11-2026, §5.3.3):
 * donde cae un dictado, el gesto de mantener Espacio, y que botones hay y
 * cuanto lugar piden.
 *
 * Todo puro: la web no tiene tests propios, asi que lo prueba
 * `check-native-voice.mjs` importando de aca.
 */

import type { NativeVoiceControl, NativeVoiceMode, TerminalActivity } from '@agent-workbench/shared';

/** Cuanto hay que mantener Espacio para que arranque la voz. Un toque normal dura una fraccion de eso. */
export const HOLD_TO_TALK_MS = 1_000;

/**
 * Lo que se escribe en el cuadro cuando llega un dictado, en el cursor: separado
 * de lo que ya hay por un espacio (o ninguno, si ya hay uno o un salto de
 * linea), para que no quede pegado a la palabra de al lado. `text` ya viene sin
 * espacios en los extremos.
 */
export function dictationInsertion(value: string, start: number, end: number, text: string): string {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const spaceBefore = before.length > 0 && !/\s$/.test(before);
  const spaceAfter = after.length > 0 && !/^\s/.test(after);
  return `${spaceBefore ? ' ' : ''}${text}${spaceAfter ? ' ' : ''}`;
}

/** El cuadro justo antes del primer espacio de una pulsacion larga. */
export interface SpaceSnapshot {
  value: string;
  start: number;
}

/**
 * El espacio que escribio el primer toque de una pulsacion larga, si sigue
 * siendo lo unico que cambio: el cuadro dice lo de antes con un espacio en el
 * cursor, y el cursor esta justo detras. null si no esta (o si cambio otra cosa:
 * no se toca lo que el usuario escribio).
 */
export function typedSpaceRange(before: SpaceSnapshot, value: string, caret: number): { from: number; to: number } | null {
  const expected = `${before.value.slice(0, before.start)} ${before.value.slice(before.start)}`;
  return value === expected && caret === before.start + 1 ? { from: before.start, to: before.start + 1 } : null;
}

export interface SpaceKeyEvent {
  key: string;
  repeat: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/** El cuadro en el momento de la tecla. */
export interface SpaceBox {
  value: string;
  start: number;
  end: number;
}

export interface SpaceHoldHooks {
  /** true si se puede arrancar la voz ahora: ofrecida, sin bloqueo y sin otra en curso. */
  canStart(): boolean;
  /** Pasado el tiempo con la tecla abajo: arrancar. */
  onHold(snapshot: SpaceSnapshot): void;
  /** Se solto la tecla de una voz que arranco este gesto. */
  onRelease(): void;
  schedule(callback: () => void, ms: number): unknown;
  unschedule(handle: unknown): void;
}

type HoldPhase = 'idle' | 'armed' | 'holding';

/**
 * Mantener Espacio arranca la voz, como el boton (06-11-2026).
 *
 * El primer espacio se escribe como siempre, para que escribir deprisa no se
 * trabe: lo borra quien llama si la pulsacion resulta larga (`typedSpaceRange`).
 * Las repeticiones que manda el teclado **se tragan** mientras el gesto esta
 * armado, y no llenan el cuadro de espacios. Soltar antes de tiempo no hace nada
 * mas. Con la voz ocupada, un modificador, el IME o texto seleccionado, la tecla
 * es un espacio cualquiera.
 */
export class SpaceHoldGesture {
  private phase: HoldPhase = 'idle';
  private timer: unknown = null;
  private snapshot: SpaceSnapshot | null = null;

  constructor(
    private readonly hooks: SpaceHoldHooks,
    private readonly holdMs: number = HOLD_TO_TALK_MS,
  ) {}

  /** La voz arranco por este gesto y la tecla sigue abajo. */
  get holding(): boolean {
    return this.phase === 'holding';
  }

  /** true: la tecla se traga (`preventDefault`). */
  keyDown(event: SpaceKeyEvent, box: SpaceBox): boolean {
    if (event.key !== ' ') return false;
    if (event.repeat) return this.phase !== 'idle';
    // Un toque nuevo sin haber soltado el anterior (se perdio el keyup): se empieza de nuevo.
    this.reset();
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false;
    if (box.start !== box.end || !this.hooks.canStart()) return false;
    this.snapshot = { value: box.value, start: box.start };
    this.phase = 'armed';
    this.timer = this.hooks.schedule(() => this.fire(), this.holdMs);
    return false;
  }

  keyUp(event: { key: string }): void {
    if (event.key !== ' ') return;
    const wasHolding = this.phase === 'holding';
    this.reset();
    if (wasHolding) this.hooks.onRelease();
  }

  /** Se perdio el foco, o la voz termino por otro lado: todo como al principio, sin soltar nada. */
  cancel(): void {
    this.reset();
  }

  private fire(): void {
    this.timer = null;
    if (this.phase !== 'armed' || this.snapshot === null) return;
    this.phase = 'holding';
    this.hooks.onHold(this.snapshot);
  }

  private reset(): void {
    if (this.timer !== null) {
      this.hooks.unschedule(this.timer);
      this.timer = null;
    }
    this.phase = 'idle';
    this.snapshot = null;
  }
}

export interface ComposerButtons {
  showStop: boolean;
  showSend: boolean;
}

/**
 * Enviar solo aparece con algo para enviar (06-11-2026: antes se veia apagado
 * con el cuadro vacio); Detener, con el agente trabajando o esperando una
 * respuesta, que es cuando hay un turno abierto que cortar.
 *
 * Lo que no se sabe no cuenta como trabajando (06-11-2026): una pestana nueva
 * de Codex o de Antigravity, sin primer mensaje, esta `unknown` y dibujaba un
 * Detener sin nada que detener. Claude Code, que siempre publica su estado,
 * lo sigue mostrando trabajando o esperando. Esc dentro del cuadro interrumpe
 * igual, se vea o no el boton.
 */
export function composerButtons(input: {
  alive: boolean;
  activity: TerminalActivity | undefined;
  hasSomething: boolean;
}): ComposerButtons {
  const working = input.activity === 'busy' || input.activity === 'waiting';
  return { showStop: input.alive && working, showSend: input.hasSomething };
}

/**
 * Cuantos botones de lugar reserva el cuadro a la derecha del texto. Sale de
 * los botones que **pueden** aparecer y no de los que se ven ahora: Enviar
 * siempre tiene su lugar, aunque no se vea, y asi el texto no salta al escribir
 * la primera letra. `voiceButtons` es uno por modo de voz de la CLI: el
 * microfono del dictado y las rayitas de la voz en vivo, uno al lado del otro.
 */
export function actionSlots(input: { voiceButtons: number; stop: boolean; suggestion: boolean }): number {
  return 1 + (input.stop ? 1 : 0) + (input.suggestion ? 1 : 0) + input.voiceButtons;
}

/** Los controles que se mantienen apretados (dictado), en vez de un clic para arrancar y otro para parar. */
export function isHoldControl(control: NativeVoiceControl | undefined): boolean {
  return control === 'claude-hold-space' || control === 'antigravity-dictation';
}

/**
 * Que modo arranca mantener Espacio: el del dictado, que es el que se mantiene
 * apretado; una CLI que solo tiene voz en vivo (Codex) arranca esa. null sin voz.
 */
export function spaceHoldMode(modes: readonly { mode: NativeVoiceMode; control: NativeVoiceControl }[]): NativeVoiceMode | null {
  return (modes.find((item) => isHoldControl(item.control)) ?? modes[0])?.mode ?? null;
}
