/**
 * Esperar en la pantalla de una CLI a que algo se vea, y quieto (§6.35.1).
 *
 * La pantalla es la emulada de la pestana (`pty-screen.ts`). Se acepta una
 * lectura solo si la siguiente da lo mismo: un redibujo que llega en dos trozos
 * deja un instante la pantalla a medio cambiar (lo mismo que encontro el menu de
 * rewind, §4.16). Sin nombrar ninguna CLI: lo que se mira lo dice quien llama.
 */

import type { RewindIo } from './adapter.js';

export interface ScreenWaitTiming {
  /** Cuanto se espera a que la pantalla cumpla. */
  timeoutMs: number;
  /** Cada cuanto se mira. */
  pollMs: number;
}

/**
 * `read` devuelve la parte de la pantalla que importa si cumple, o null si no.
 * Devuelve esa parte cuando dio lo mismo dos lecturas seguidas, o null si no
 * llego a tiempo.
 */
export async function waitForStableScreen(
  io: Pick<RewindIo, 'screen' | 'wait' | 'now'>,
  read: (lines: readonly string[]) => string | null,
  timing: ScreenWaitTiming,
): Promise<string | null> {
  const deadline = io.now() + timing.timeoutMs;
  let candidate: string | null = null;
  for (;;) {
    const value = read(await io.screen());
    if (value !== null && value === candidate) return value;
    candidate = value;
    if (io.now() >= deadline) return null;
    await io.wait(timing.pollMs);
  }
}
