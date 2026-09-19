/**
 * El sonido de aviso (hito 32, §6.20).
 *
 * Existe por un pedido concreto: el usuario deja la pestaña abierta, se va a
 * hacer otra cosa, y quiere enterarse de que el agente terminó o de que se
 * frenó a esperarlo. Son dos sonidos y no uno, porque saber cuál de las dos
 * cosas pasó cambia si vale la pena volver ya.
 *
 * **No hay archivo de audio.** Las notas se sintetizan con la Web Audio API:
 * dos senoidales con caída, unos 400 ms en total, a volumen bajo. Es la misma
 * decisión que el punto de la pestaña (§6.12): a código, sin meter un binario
 * en un repositorio público, y sin depender de que un `.wav` llegue al
 * paquete de npm.
 *
 * Este archivo no tiene React ni JSX a propósito: la decisión de qué suena es
 * pura y la cubre `check-notification-sound.mjs`; el sintetizador es lo único
 * que toca el navegador, y está al final.
 */

import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';
import { t } from './i18n/index.js';

/** `done`: el agente terminó. `attention`: se frenó a esperar un permiso o una respuesta. */
export type Chime = 'done' | 'attention';

/**
 * Cuánto tiene que sostenerse `idle` antes de sonar "terminó".
 *
 * El estado que publica la CLI puede pasar por `idle` entre dos herramientas;
 * sonar en cada hueco sería repicar toda la corrida. Si vuelve a `busy` antes
 * de este plazo, no sonó nada.
 */
export const DONE_HOLD_MS = 1500;

/**
 * Qué aviso sale de un cambio de estado de una pestaña, o null si ninguno.
 *
 * Sólo dos transiciones suenan: `busy → idle` es "terminó", y cualquier cosa
 * `→ waiting` es "te espera". Sin estado anterior no suena: es la tanda que
 * llega al conectar, o una pestaña recién lanzada, y ahí no cambió nada.
 * `unknown` y `offline` no suenan nunca: no dicen que el agente haya hecho
 * algo, y con Codex es lo único que hay (no publica estado).
 */
export function chimeFor(previous: TerminalActivity | undefined, next: TerminalActivity): Chime | null {
  if (previous === undefined || previous === next) return null;
  if (next === 'waiting') return 'attention';
  if (next === 'idle' && previous === 'busy') return 'done';
  return null;
}

/** Lo que hay que hacer tras un latido del mapa de actividad. */
export interface ChimePlan {
  /** Suenan ya: "te espera". */
  now: TerminalId[];
  /** Arrancan el plazo de `DONE_HOLD_MS`: "terminó", si `idle` se sostiene. */
  later: TerminalId[];
  /** Pestañas cuyo plazo pendiente se cancela: cambiaron de estado o se cerraron. */
  cancel: TerminalId[];
}

/**
 * Compara el mapa anterior con el nuevo y dice qué suena, qué espera y qué se
 * cancela. Pura: el hook sólo ejecuta el plan con temporizadores.
 *
 * Cualquier cambio de estado cancela el plazo que esa pestaña tuviera —también
 * `busy → idle → waiting`, donde el "terminó" en espera muere y suena sólo "te
 * espera"—, y una pestaña que desapareció del mapa (cerrada, dormida) cancela
 * el suyo. Cancelar un plazo que no existe no cuesta nada, y así el hook no
 * lleva la cuenta de cuáles están vivos.
 */
export function planChimes(
  previous: ReadonlyMap<TerminalId, TerminalActivity>,
  next: ReadonlyMap<TerminalId, TerminalActivity>,
): ChimePlan {
  const plan: ChimePlan = { now: [], later: [], cancel: [] };
  for (const [terminalId, activity] of next) {
    const before = previous.get(terminalId);
    if (before === activity) continue;
    plan.cancel.push(terminalId);
    const chime = chimeFor(before, activity);
    if (chime === 'attention') plan.now.push(terminalId);
    else if (chime === 'done') plan.later.push(terminalId);
  }
  for (const terminalId of previous.keys()) {
    if (!next.has(terminalId)) plan.cancel.push(terminalId);
  }
  return plan;
}

export const SOUND_STORAGE_KEY = 'agent-workbench.sound';

/** La preferencia guardada, o null si no es una de las dos palabras. */
export function parseStoredSound(raw: string): boolean | null {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return null;
}

export function soundButtonTitle(enabled: boolean): string {
  return enabled ? t('sound.on') : t('sound.off');
}

/** Una nota: frecuencia en Hz, cuándo arranca y cuánto dura, en segundos. */
export interface Note {
  frequency: number;
  at: number;
  duration: number;
}

/**
 * Las dos melodías. "Terminó" baja (la5 → mi5) y "te espera" sube (mi5 → si5):
 * la misma forma en las dos, y el sentido es lo que las distingue. Ninguna
 * pasa del medio segundo: es un aviso, no una alarma.
 */
export const CHIMES: Readonly<Record<Chime, readonly Note[]>> = {
  done: [
    { frequency: 880, at: 0, duration: 0.18 },
    { frequency: 659.25, at: 0.14, duration: 0.28 },
  ],
  attention: [
    { frequency: 659.25, at: 0, duration: 0.18 },
    { frequency: 987.77, at: 0.14, duration: 0.28 },
  ],
};

/**
 * El volumen es el pico de ganancia de una nota, y lo elige el usuario con la
 * barrita del botón (hito 36). Nació fijo en 0,12 y resultó bajo; el default
 * subió a 0,2 y el tope es 0,8, para un día en que hay que enterarse sí o sí
 * —fue 0,5 un rato, y con parlantes chicos seguía corto—. Las dos notas de una
 * melodía casi no se pisan, así que ni al tope la suma llega a saturar.
 * El piso no es cero: silenciar es el clic del botón, no la barrita.
 */
export const MIN_VOLUME = 0.02;
export const MAX_VOLUME = 0.8;
export const DEFAULT_VOLUME = 0.2;
export const VOLUME_STORAGE_KEY = 'agent-workbench.sound-volume';

/** Un volumen dentro del rango, venga de donde venga. */
export function clampVolume(value: number): number {
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, value));
}

/** El volumen guardado, acotado al rango, o null si no es un número. */
export function parseStoredVolume(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampVolume(parsed) : null;
}

/** El volumen como porcentaje del tope, que es lo que se le muestra al usuario. */
export function volumePercent(volume: number): number {
  return Math.round((clampVolume(volume) / MAX_VOLUME) * 100);
}

/**
 * El sintetizador. Es lo único de este archivo que habla con el navegador.
 *
 * El navegador no deja sonar nada hasta que el usuario tocó la página, y un
 * `AudioContext` creado antes nace suspendido. `unlock()` se llama desde el
 * primer clic o tecla, y hasta ahí `play()` no hace nada y no falla: un aviso
 * que no se pudo dar no es un error.
 */
export class ChimePlayer {
  private context: AudioContext | null = null;

  /** El pico de ganancia de la próxima nota. Se lee al sonar, no al crear. */
  volume = DEFAULT_VOLUME;

  /** Crea o despierta el contexto. Sólo tiene efecto dentro de un gesto del usuario. */
  unlock(): void {
    if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;
    this.context ??= new window.AudioContext();
    if (this.context.state === 'suspended') {
      void this.context.resume().catch(() => undefined);
    }
  }

  get ready(): boolean {
    return this.context?.state === 'running';
  }

  play(chime: Chime): void {
    const context = this.context;
    if (context === null || context.state !== 'running') return;
    const start = context.currentTime + 0.01;
    for (const note of CHIMES[chime]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = note.frequency;
      const at = start + note.at;
      // Ataque corto y caída exponencial: sin el ataque, el arranque hace clic.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(clampVolume(this.volume), at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + note.duration + 0.02);
    }
  }
}
