/**
 * El dialogo que la CLI muestra al reanudar una sesion vieja y grande.
 *
 * ```
 * This session is 22h 23m old and 231.8k tokens.
 * Resuming the full session will consume a substantial portion of your usage
 * limits. We recommend resuming from a summary.
 * > 1. Resume from summary (recommended)
 *   2. Resume full session as-is
 *   3. Don't ask me again
 * ```
 *
 * El usuario elige **siempre** la 2, y pidio que la app lo haga por el.
 *
 * **Traerlo a la conversacion no se puede**, y por eso esto existe: el dialogo
 * aparece antes de que la sesion cargue, su texto no esta en el JSONL, y el
 * estado que la CLI publica por proceso dice que hay un dialogo abierto pero no
 * cual ni con que opciones.
 *
 * ## Cuando aparece
 *
 * Extraido del binario de la 2.1.261: hace falta que la sesion tenga mas de
 * `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (70) y mas de
 * `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (100k). O sea que la mayoria de los
 * `--resume` no lo muestran, y esto no tiene que hacer nada en ese caso.
 *
 * ## Las dos condiciones, y por que son dos
 *
 * Esto escribe a ciegas en un TUI, con el mismo cuidado que las respuestas a
 * una pregunta (CLAUDE.md 5.5). Se manda el `2` solo si se cumplen las dos:
 *
 * 1. **El estado del proceso dice que hay un dialogo abierto.** Medido con una
 *    pty propia: a los 3,3 s de lanzar con `--resume`,
 *    `~/.claude/sessions/<pid>.json` pasa a
 *    `{"status":"waiting","waitingFor":"dialog open"}`.
 * 2. **La salida trae el literal `Resume full session as-is`.** Es la unica
 *    forma de saber que el dialogo abierto es **este**. No es la heuristica que
 *    el proyecto descarta —"¿esto parece un pedido de permiso?"— sino la
 *    presencia exacta de una cadena que solo imprime este dialogo.
 *
 * Con una sola de las dos no alcanza. Un `dialog open` puede ser otro dialogo
 * de arranque (Remote Control, un aviso de modelo) y ahi un `2` elige lo que
 * venga. Y el literal solo, sin el estado, no dice que el menu este esperando.
 *
 * El de confianza en la carpeta —cuyo `2` es "Yes, I trust this folder"— ni
 * siquiera llega a la primera condicion: medido, la CLI no registra la sesion
 * en `sessions/` hasta despues de que se acepta.
 *
 * ## Lo que se paga
 *
 * Que el usuario deja de ver la opcion "resumir desde un resumen". Es lo que
 * pidio. El aviso de consumo sigue apareciendo un instante en la solapa CLI, y
 * si algun dia molesta, la alternativa esta escrita en `docs/plan-hito-18.md`.
 */

import type { CliStatusWatcher } from './cli-status.js';

/**
 * El texto que solo imprime este dialogo, sin caracteres que no sean letras.
 *
 * Se compara asi porque la CLI **no escribe espacios**: mueve el cursor con
 * `ESC[nC`, asi que quitarle las secuencias de escape al flujo devuelve las
 * palabras pegadas. Es lo mismo que hubo que hacer para medir el menu de
 * preguntas (CLAUDE.md 5.5).
 */
const DIALOG_MARKER = 'Resumefullsessionasis';

/** Cuanto se espera al dialogo antes de dejar de mirar. */
const DEADLINE_MS = 25_000;

/** Que se manda: el numero de la opcion y su Enter. */
const CHOICE_KEYS: readonly string[] = ['2', '\r'];

/**
 * Espera entre el numero y el Enter.
 *
 * Por lo mismo que las teclas de una respuesta (`ANSWER_KEY_INTERVAL_MS`):
 * mandadas juntas, el menu se queda a mitad. Cada tecla tiene que caer sobre
 * el estado que dejo la anterior.
 */
const KEY_INTERVAL_MS = 120;

/** Deja solo las letras: ver `DIALOG_MARKER`. */
function lettersOnly(raw: string): string {
  return raw.replace(/[^A-Za-z]/g, '');
}

export interface AutoResumeOptions {
  watcher: CliStatusWatcher;
  sessionId: string;
  /** La salida acumulada de la pty hasta ahora. */
  readOutput: () => string;
  /** Escribe en la pty. Devuelve false si la terminal ya no esta. */
  write: (data: string) => boolean;
  /** Se llama una sola vez, con lo que paso. Para el log. */
  onDone?: (outcome: 'answered' | 'timeout' | 'cancelled') => void;
}

/**
 * Contesta la 2 si el dialogo aparece. Devuelve una funcion para cancelar.
 *
 * Cancelar es lo que corresponde en cuanto el usuario escribe algo el mismo:
 * si ya esta tecleando, el menu no esta como lo dejamos y un `2` cae en
 * cualquier lado.
 */
export function autoAnswerResumeDialog(options: AutoResumeOptions): () => void {
  let finished = false;
  let unsubscribe: (() => void) | null = null;

  const finish = (outcome: 'answered' | 'timeout' | 'cancelled'): void => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    unsubscribe?.();
    unsubscribe = null;
    options.onDone?.(outcome);
  };

  const deadline = setTimeout(() => finish('timeout'), DEADLINE_MS);
  deadline.unref();

  const answer = async (): Promise<void> => {
    for (const [index, key] of CHOICE_KEYS.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, KEY_INTERVAL_MS));
      }
      // La pestana se cerro entre una tecla y la otra: no hay nada que
      // arreglar escribiendo la siguiente.
      if (!options.write(key)) return;
    }
  };

  unsubscribe = options.watcher.subscribe(options.sessionId, (status) => {
    if (finished) return;
    if (status === null || status.status !== 'waiting') return;
    if (status.waitingFor !== 'dialog open') return;
    if (!lettersOnly(options.readOutput()).includes(DIALOG_MARKER)) return;

    // Se marca antes de escribir: el `subscribe` puede volver a disparar
    // mientras las dos teclas van saliendo, y una segunda tanda escribiria un
    // `2` suelto en el prompt.
    finish('answered');
    void answer();
  });

  return () => finish('cancelled');
}
