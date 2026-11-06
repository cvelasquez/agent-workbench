/**
 * La voz nativa de la CLI, en el cuadro de escritura (§5.3.3).
 *
 * Al cuadro le interesa arrancar, parar y saber en que estado esta la voz de la
 * pestana que muestra. El servidor es quien escribe en la CLI (`native-voice.ts`);
 * aca solo se manda `agent.voice` y se escuchan sus acuses. Un boton por modo,
 * uno al lado del otro (el microfono y las rayitas, como en una app de chat):
 *
 *  - **Dictado** (Claude Code, Antigravity): se mantiene el boton (o Espacio) y,
 *    al soltar, el servidor espera a que la CLI termine de transcribir, saca el
 *    texto de su caja y lo manda en un `agent.voice.text`. Mientras tanto el
 *    boton queda ocupado y Enviar apagado.
 *  - **En vivo** (Codex, Antigravity): un clic arranca y otro detiene.
 *
 * Sacado de `Composer.tsx` porque el gesto de mantener Espacio se engancha a las
 * teclas del cuadro, que se declaran antes que el resto de la voz.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  NativeVoiceCapability,
  NativeVoiceMode,
  TerminalId,
  VoiceDictationOutcome,
} from '@agent-workbench/shared';
import { SpaceHoldGesture, isHoldControl, spaceHoldMode, type SpaceSnapshot } from './composer-voice.js';
import type { AgentConnection } from './connection.js';

export type VoicePhase = 'idle' | 'listening' | 'transcribing';

/** Lo que se le dice al usuario de un dictado que no llego al cuadro. */
export type VoiceNotice = Exclude<VoiceDictationOutcome, 'text'>;

/** Si el servidor nunca contesta (un corte de red), el boton no queda ocupado para siempre. */
const TRANSCRIBING_FAILSAFE_MS = 30_000;
const NOTICE_MS = 5_000;

interface VoiceSession {
  terminalId: TerminalId;
  mode: NativeVoiceMode;
  hold: boolean;
  /** Arranco por mantener Espacio en el cuadro, no por el boton. */
  bySpace: boolean;
}

interface VoiceState {
  phase: VoicePhase;
  /** El modo que graba o transcribe; null sin nada en curso. */
  mode: NativeVoiceMode | null;
}

const IDLE: VoiceState = { phase: 'idle', mode: null };

export interface UseComposerVoiceOptions {
  connection: AgentConnection;
  terminalId: TerminalId | null;
  /** El cuadro esta apagado: sin CLI viva. */
  disabled: boolean;
  nativeVoice: NativeVoiceCapability | null;
  /** Una pregunta o un permiso abierto en la CLI: dictar escribiria sobre su menu. */
  blocked: boolean;
  /** Lo dictado, listo para el cuadro de esa pestana (la que se muestra, o su borrador). */
  onDictated: (terminalId: TerminalId, text: string) => void;
  /** Quita el espacio que escribio el primer toque de una pulsacion larga. */
  onHeldSpace: (snapshot: SpaceSnapshot) => void;
}

/** Lo que lleva un boton de voz: el gesto del puntero y del teclado. */
export interface VoiceButtonProps {
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onBlur: () => void;
  onClick: () => void;
}

export interface VoiceControl {
  mode: NativeVoiceMode;
  /** Se mantiene apretado (dictado), en vez de un clic para arrancar y otro para parar. */
  hold: boolean;
  /** Grabando o en vivo ahora: el boton va en rojo. */
  active: boolean;
  /** La CLI esta transcribiendo lo dictado. */
  busy: boolean;
  disabled: boolean;
  props: VoiceButtonProps;
}

export interface ComposerVoice {
  /** Un boton por modo, en el orden en que la CLI los declara. */
  controls: readonly VoiceControl[];
  /** Hay voz que ofrecer en esta pestana. */
  available: boolean;
  /** Un dictado en curso (grabando o transcribiendo): lo escrito todavia no esta completo. */
  dictating: boolean;
  notice: VoiceNotice | null;
  dismissNotice: () => void;
  /** Las teclas del cuadro: true si la tecla se traga (una repeticion de Espacio mantenido). */
  textKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  textKeyUp: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  textBlur: () => void;
  /** Esc con la voz grabando la cancela, en vez de interrumpir al agente. true si habia algo. */
  cancelListening: () => boolean;
}

export function useComposerVoice(options: UseComposerVoiceOptions): ComposerVoice {
  const { connection, terminalId, disabled, nativeVoice, blocked, onDictated, onHeldSpace } = options;
  const [state, setStateValue] = useState<VoiceState>(IDLE);
  const [notice, setNotice] = useState<VoiceNotice | null>(null);
  const session = useRef<VoiceSession | null>(null);
  const stateRef = useRef<VoiceState>(IDLE);
  const setState = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const modes = useMemo(() => nativeVoice?.modes ?? [], [nativeVoice]);
  const available = !disabled && nativeVoice !== null && modes.length > 0;

  // Lo ultimo, para los gestos que corren fuera del render (un temporizador, una tecla).
  const latest = useRef({ terminalId, disabled, nativeVoice, blocked, onDictated, onHeldSpace, available });
  latest.current = { terminalId, disabled, nativeVoice, blocked, onDictated, onHeldSpace, available };

  const finish = useCallback(
    (cancel = false): void => {
      const current = session.current;
      if (current === null) return;
      session.current = null;
      // Un dictado detenido queda transcribiendo hasta que llegue el texto; uno cancelado, no.
      setState(!cancel && current.mode === 'dictation' ? { phase: 'transcribing', mode: 'dictation' } : IDLE);
      connection.send({
        type: 'agent.voice',
        terminalId: current.terminalId,
        mode: current.mode,
        action: cancel ? 'cancel' : 'stop',
      });
    },
    [connection, setState],
  );

  const start = useCallback(
    (wanted: NativeVoiceMode | null, bySpace = false): boolean => {
      const { terminalId: id, disabled: off, nativeVoice: capability, blocked: stuck } = latest.current;
      if (wanted === null || id === null || off || capability === null) return false;
      if (session.current !== null || stateRef.current.phase !== 'idle') return false;
      const option = capability.modes.find((item) => item.mode === wanted);
      if (option === undefined || (wanted === 'dictation' && stuck)) return false;
      if (!connection.send({ type: 'agent.voice', terminalId: id, mode: wanted, action: 'start' })) return false;
      session.current = { terminalId: id, mode: wanted, hold: isHoldControl(option.control), bySpace };
      setNotice(null);
      setState({ phase: 'listening', mode: wanted });
      return true;
    },
    [connection, setState],
  );

  const toggle = useCallback(
    (wanted: NativeVoiceMode): void => {
      const current = session.current;
      if (current !== null) {
        if (current.mode === wanted) finish(false);
        return;
      }
      start(wanted);
    },
    [finish, start],
  );

  // Mantener Espacio en el cuadro arranca la voz (el dictado, o la en vivo si es la unica), como el boton.
  const gesture = useMemo(
    () =>
      new SpaceHoldGesture({
        canStart: () => {
          const wanted = spaceHoldMode(latest.current.nativeVoice?.modes ?? []);
          return (
            wanted !== null &&
            latest.current.available &&
            session.current === null &&
            stateRef.current.phase === 'idle' &&
            !(wanted === 'dictation' && latest.current.blocked)
          );
        },
        onHold: (snapshot) => {
          latest.current.onHeldSpace(snapshot);
          start(spaceHoldMode(latest.current.nativeVoice?.modes ?? []), true);
        },
        onRelease: () => {
          const current = session.current;
          if (current !== null && current.bySpace && current.hold) finish(false);
        },
        schedule: (callback, ms) => window.setTimeout(callback, ms),
        unschedule: (handle) => window.clearTimeout(handle as number),
      }),
    [finish, start],
  );

  // Cambiar de pestana, o quedarse sin CLI: lo que grababa se descarta.
  useEffect(() => {
    setState(IDLE);
    setNotice(null);
    return () => {
      gesture.cancel();
      const current = session.current;
      if (current === null) return;
      session.current = null;
      connection.send({ type: 'agent.voice', terminalId: current.terminalId, mode: current.mode, action: 'cancel' });
    };
  }, [connection, gesture, setState, terminalId]);

  useEffect(() => {
    if (disabled) {
      gesture.cancel();
      finish(true);
    }
  }, [disabled, finish, gesture]);

  useEffect(() => {
    const cancelOnBlur = (): void => {
      gesture.cancel();
      finish(true);
    };
    const cancelWhenHidden = (): void => {
      if (document.hidden) cancelOnBlur();
    };
    window.addEventListener('blur', cancelOnBlur);
    document.addEventListener('visibilitychange', cancelWhenHidden);
    const removeStatus = connection.onStatus((status) => {
      if (status === 'open') return;
      gesture.cancel();
      session.current = null;
      setState(IDLE);
    });
    const removeMessages = connection.onMessage((message) => {
      if (message.type === 'agent.voice.status') {
        if (message.terminalId !== latest.current.terminalId || message.active) return;
        const current = session.current;
        if (current !== null && current.mode === message.mode) session.current = null;
        setState(message.transcribing === true ? { phase: 'transcribing', mode: message.mode } : IDLE);
        return;
      }
      if (message.type === 'agent.voice.text') {
        if (message.outcome === 'text' && message.text.trim().length > 0) {
          latest.current.onDictated(message.terminalId, message.text.trim());
        }
        if (message.terminalId !== latest.current.terminalId) return;
        setState(IDLE);
        if (message.outcome !== 'text') setNotice(message.outcome);
      }
    });
    return () => {
      window.removeEventListener('blur', cancelOnBlur);
      document.removeEventListener('visibilitychange', cancelWhenHidden);
      removeStatus();
      removeMessages();
    };
  }, [connection, finish, gesture, setState]);

  useEffect(() => {
    if (state.phase !== 'transcribing') return;
    const timer = window.setTimeout(() => setState(IDLE), TRANSCRIBING_FAILSAFE_MS);
    return () => window.clearTimeout(timer);
  }, [setState, state.phase]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const controls = useMemo<VoiceControl[]>(
    () =>
      modes.map((option) => {
        const mode = option.mode;
        const hold = isHoldControl(option.control);
        const active = state.phase === 'listening' && state.mode === mode;
        const busy = state.phase === 'transcribing' && state.mode === mode;
        // Con otro modo grabando o transcribiendo, este espera; el que graba sigue activo para poder pararlo.
        const off = disabled || (state.phase !== 'idle' && !active) || (mode === 'dictation' && blocked);
        const props: VoiceButtonProps = {
          onPointerDown: (event) => {
            if (!hold) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            start(mode);
          },
          onPointerUp: () => {
            if (session.current?.mode === mode && session.current.hold) finish(false);
          },
          onPointerCancel: () => {
            if (session.current?.mode === mode) finish(true);
          },
          onLostPointerCapture: () => {
            if (session.current?.mode === mode && session.current.hold) finish(true);
          },
          onKeyDown: (event) => {
            if (!hold || (event.key !== ' ' && event.key !== 'Enter')) return;
            event.preventDefault();
            if (!event.repeat) start(mode);
          },
          onKeyUp: (event) => {
            if (!hold || (event.key !== ' ' && event.key !== 'Enter')) return;
            event.preventDefault();
            if (session.current?.mode === mode) finish(false);
          },
          onBlur: () => {
            if (session.current?.mode === mode && session.current.hold) finish(true);
          },
          onClick: () => {
            if (!hold) toggle(mode);
          },
        };
        return { mode, hold, active, busy, disabled: !active && off, props };
      }),
    [blocked, disabled, finish, modes, start, state.mode, state.phase, toggle],
  );

  const textKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const element = event.currentTarget;
      return gesture.keyDown(
        {
          key: event.key,
          repeat: event.repeat,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          isComposing: event.nativeEvent.isComposing,
        },
        { value: element.value, start: element.selectionStart, end: element.selectionEnd },
      );
    },
    [gesture],
  );

  const textKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => gesture.keyUp({ key: event.key }),
    [gesture],
  );

  // Perder el foco con Espacio abajo: el keyup ya no llega al cuadro, asi que cuenta como soltar.
  const textBlur = useCallback((): void => {
    gesture.cancel();
    const current = session.current;
    if (current !== null && current.bySpace && current.hold) finish(false);
  }, [finish, gesture]);

  const cancelListening = useCallback((): boolean => {
    if (session.current === null) return false;
    gesture.cancel();
    finish(true);
    return true;
  }, [finish, gesture]);

  return {
    controls,
    available,
    dictating: state.mode === 'dictation' && state.phase !== 'idle',
    notice,
    dismissNotice: () => setNotice(null),
    textKeyDown,
    textKeyUp,
    textBlur,
    cancelListening,
  };
}
