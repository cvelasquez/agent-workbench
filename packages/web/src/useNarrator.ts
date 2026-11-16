/**
 * El narrador (hito 57, §6.40): lee en voz alta los mensajes del agente de una
 * pestaña, para seguirla sin mirarla.
 *
 * Una sola pestaña en toda la app, y una sola ventana que habla: lo guarda el
 * servidor (`narrator.state`), así no se cruzan dos voces entre ventanas o
 * equipos. Esta ventana se reconoce por un id en `sessionStorage`.
 *
 * Lo que se dice lo decide `narrator-text.ts`, y la voz `narrator-voices.ts`,
 * los dos puros. Acá sólo se ejecuta: la suscripción a la pestaña narrada
 * aunque no se mire (por el registro que comparte con el hilo), la fila, la voz
 * del navegador (`speechSynthesis`) y el gesto que el navegador exige antes de
 * hablar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationEvent, NarratorHolder, TerminalActivity, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { conversationSubscriptions } from './conversation-subscriptions.js';
import { getLocale, t } from './i18n/index.js';
import { insidePhoneApp } from './narrow-layout.js';
import { chimeFor } from './notification-sound.js';
import { NarratorQueue, narratorMessages, planReset, speechChunks, type NarratorPhrases } from './narrator-text.js';
import {
  DEFAULT_RATE,
  NARRATOR_RATE_STORAGE_KEY,
  NARRATOR_VOICE_STORAGE_KEY,
  NARRATOR_WINDOW_STORAGE_KEY,
  clampRate,
  localVoices,
  newWindowId,
  parseStoredRate,
  parseStoredVoice,
  pickVoice,
  voiceOptions,
  voicePlatform,
  type VoiceChoice,
  type VoiceInfo,
  type VoicePlatform,
} from './narrator-voices.js';
import { readStored, writeStored } from './window-prefs.js';

/** Hasta dónde se leyó, para retomar tras un F5 sin repetir (por ventana). */
const LAST_SEEN_STORAGE_KEY = 'agent-workbench.narrator-last';

/** Cuánto se espera la lista de voces antes de darla por vacía: un Linux sin voces no avisa nunca. */
const VOICES_DEADLINE_MS = 2000;

/** Los ids vistos que se recuerdan: de sobra para el tramo de un `reset`. */
const MAX_SEEN = 2000;

/** Lo que pide encender el narrador, mientras el aviso de la voz que falta está abierto. */
export interface NarratorVoicePrompt {
  terminalId: TerminalId;
  /** La que se usaría igual, o null si no hay ninguna local. */
  fallback: VoiceInfo | null;
  /** Ya se volvió a mirar la lista y no apareció: hay que reiniciar el navegador. */
  rechecked: boolean;
}

export interface NarratorState {
  /** Este navegador puede narrar y este servidor tiene narrador. */
  available: boolean;
  /** Ya se sabe qué voces hay (o se dejó de esperar la lista). */
  voicesKnown: boolean;
  /** Hay al menos una voz local; sin ninguna, el botón queda apagado con los pasos. */
  hasLocalVoice: boolean;
  /** Quién narra en toda la app, o null. */
  holder: NarratorHolder | null;
  /** Esta ventana es la que habla. */
  isOwner: boolean;
  /** Está diciendo algo, o tiene algo en fila. */
  speaking: boolean;
  /** Cuántos mensajes esperan detrás del que se dice. */
  pending: number;
  /** El navegador no deja hablar hasta un clic (tras un F5). */
  needsGesture: boolean;
  /** La voz elegida, o la que falta. */
  choice: VoiceChoice;
  /** Las voces para Ajustes: locales, las del idioma primero. */
  voices: VoiceInfo[];
  /** La guardada en Ajustes; null es "automática". */
  savedVoice: string | null;
  rate: number;
  platform: VoicePlatform;
  /** El aviso de la voz que falta, si está abierto. */
  voicePrompt: NarratorVoicePrompt | null;
  /** Encender en esta pestaña, para esta ventana. `events`: lo que el hilo ya muestra, que no se lee. */
  activate(terminalId: TerminalId, events: readonly ConversationEvent[]): void;
  turnOff(): void;
  /** Pasa al mensaje siguiente. */
  skip(): void;
  /** Corta lo que dice y lo pendiente; sigue encendido. */
  silence(): void;
  setVoice(voiceURI: string | null): void;
  setRate(rate: number): void;
  /** Una frase de prueba con la voz y la velocidad elegidas. */
  test(): void;
  /** "Ya la instalé": vuelve a mirar la lista; si apareció, enciende. */
  recheckVoices(): void;
  /** "Usar la predeterminada igual": la guarda como elegida y enciende. */
  useFallback(): void;
  closePrompt(): void;
}

function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

function toVoiceInfo(voice: SpeechSynthesisVoice): VoiceInfo {
  return { voiceURI: voice.voiceURI, name: voice.name, lang: voice.lang, localService: voice.localService, default: voice.default };
}

/** El id de esta ventana: se crea una vez y sobrevive a un F5. */
function windowIdOfThisWindow(): string {
  try {
    const stored = window.sessionStorage.getItem(NARRATOR_WINDOW_STORAGE_KEY);
    if (stored !== null && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
    const created = newWindowId((bytes) => crypto.getRandomValues(bytes));
    window.sessionStorage.setItem(NARRATOR_WINDOW_STORAGE_KEY, created);
    return created;
  } catch {
    // Sin `sessionStorage` el id dura lo que la página: un F5 pierde el narrador, nada más.
    return newWindowId((bytes) => crypto.getRandomValues(bytes));
  }
}

function readLastSeen(terminalId: TerminalId): string | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_SEEN_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return record['terminalId'] === terminalId && typeof record['eventId'] === 'string' ? record['eventId'] : null;
  } catch {
    return null;
  }
}

function writeLastSeen(terminalId: TerminalId, eventId: string): void {
  try {
    window.sessionStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify({ terminalId, eventId }));
  } catch {
    // Es para retomar tras un F5; sin esto, sólo no se retoma.
  }
}

function clearLastSeen(): void {
  try {
    window.sessionStorage.removeItem(LAST_SEEN_STORAGE_KEY);
  } catch {
    // Nada que borrar.
  }
}

/** El navegador ya recibió un gesto en esta página (Chrome lo exige antes de hablar). */
function hasUserActivation(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation === undefined ? true : activation.hasBeenActive;
}

function phrases(): NarratorPhrases {
  return { codeBlock: t('narrator.say.codeBlock'), table: t('narrator.say.table'), link: t('narrator.say.link') };
}

export function useNarrator(
  connection: AgentConnection,
  activity: ReadonlyMap<TerminalId, TerminalActivity>,
  nameOf: (terminalId: TerminalId) => string,
): NarratorState {
  const supported = useMemo(() => speechAvailable() && !insidePhoneApp(navigator.userAgent), []);
  const windowId = useMemo(() => windowIdOfThisWindow(), []);
  const platform = useMemo(() => voicePlatform(navigator.userAgent), []);

  const [serverHasNarrator, setServerHasNarrator] = useState(false);
  const [holder, setHolder] = useState<NarratorHolder | null>(null);
  const [rawVoices, setRawVoices] = useState<VoiceInfo[]>([]);
  const [voicesKnown, setVoicesKnown] = useState(false);
  const [savedVoice, setSavedVoice] = useState<string | null>(() => readStored(NARRATOR_VOICE_STORAGE_KEY, null, parseStoredVoice));
  const [rate, setRateState] = useState<number>(() => readStored(NARRATOR_RATE_STORAGE_KEY, DEFAULT_RATE, parseStoredRate));
  const [speaking, setSpeaking] = useState(false);
  const [pending, setPending] = useState(0);
  const [needsGesture, setNeedsGesture] = useState(() => !hasUserActivation());
  const [voicePrompt, setVoicePrompt] = useState<NarratorVoicePrompt | null>(null);

  const isOwner = holder !== null && holder.windowId === windowId;
  const ownedTerminal = isOwner ? holder.terminalId : null;

  const choice = useMemo(
    () => pickVoice(rawVoices, { saved: savedVoice, uiLocale: getLocale(), browserLanguages: navigator.languages ?? [] }),
    // El idioma de la interfaz cambia con un render de toda la app: se relee en cada uno.
    [rawVoices, savedVoice, getLocale()],
  );
  const voices = useMemo(() => voiceOptions(rawVoices, getLocale()), [rawVoices, getLocale()]);

  // Lo que el pump lee sin redibujar.
  const queueRef = useRef(new NarratorQueue());
  const currentRef = useRef<{ utterance: SpeechSynthesisUtterance; messageId: string; text: string } | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const lastSeenRef = useRef<string | null>(null);
  /** La pestaña que se pidió narrar: la anterior deja de anotar en cuanto se pide otra. */
  const targetRef = useRef<TerminalId | null>(null);
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const needsGestureRef = useRef(needsGesture);
  needsGestureRef.current = needsGesture;
  const nameOfRef = useRef(nameOf);
  nameOfRef.current = nameOf;

  const refreshCounts = useCallback(() => {
    setSpeaking(currentRef.current !== null || queueRef.current.size > 0);
    setPending(queueRef.current.pendingMessages());
  }, []);

  const findVoice = useCallback((voiceURI: string): SpeechSynthesisVoice | null => {
    if (!speechAvailable()) return null;
    return window.speechSynthesis.getVoices().find((voice) => voice.voiceURI === voiceURI) ?? null;
  }, []);

  /** Dice lo próximo de la fila, si no hay nada sonando y se puede. */
  const pump = useCallback(() => {
    if (!speechAvailable() || currentRef.current !== null || needsGestureRef.current) {
      refreshCounts();
      return;
    }
    const item = queueRef.current.next();
    if (item === null) {
      refreshCounts();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(item.text);
    const picked = choiceRef.current;
    const voiceInfo = picked.kind === 'voice' ? picked.voice : picked.fallback;
    const voice = voiceInfo === null ? null : findVoice(voiceInfo.voiceURI);
    if (voice !== null) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = rateRef.current;
    const finish = (event: Event): void => {
      // Sólo cuenta el que está sonando: uno cancelado avisa tarde.
      if (currentRef.current?.utterance !== utterance) return;
      currentRef.current = null;
      if ((event as Event & { error?: string }).error === 'not-allowed') {
        // El navegador pide un gesto: el trozo vuelve a la fila y espera el clic.
        queueRef.current.requeue(item);
        needsGestureRef.current = true;
        setNeedsGesture(true);
        refreshCounts();
        return;
      }
      pump();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    // Una referencia viva: Chrome deja de avisar el final de un enunciado que se recolectó.
    currentRef.current = { utterance, messageId: item.messageId, text: item.text };
    refreshCounts();
    window.speechSynthesis.speak(utterance);
  }, [findVoice, refreshCounts]);

  const stopAll = useCallback(() => {
    queueRef.current.clear();
    const current = currentRef.current;
    currentRef.current = null;
    if (current !== null && speechAvailable()) window.speechSynthesis.cancel();
    refreshCounts();
  }, [refreshCounts]);

  const say = useCallback(
    (messageId: string, text: string) => {
      const chunks = speechChunks(text);
      if (chunks.length === 0) return;
      queueRef.current.push({ messageId, chunks });
      pump();
    },
    [pump],
  );

  // El estado del narrador viene del servidor; que llegue dice también que lo tiene.
  useEffect(
    () =>
      connection.onMessage((message) => {
        if (message.type !== 'narrator.state') return;
        setServerHasNarrator(true);
        setHolder(message.narrator);
      }),
    [connection],
  );

  // Las voces llegan tarde en Chrome, y cambian si el usuario instala una.
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const read = (): void => {
      const list = synth.getVoices().map(toVoiceInfo);
      setRawVoices(list);
      if (list.length > 0) setVoicesKnown(true);
    };
    read();
    const onChange = (): void => {
      read();
      setVoicesKnown(true);
    };
    synth.addEventListener('voiceschanged', onChange);
    const deadline = window.setTimeout(() => setVoicesKnown(true), VOICES_DEADLINE_MS);
    return () => {
      synth.removeEventListener('voiceschanged', onChange);
      window.clearTimeout(deadline);
    };
  }, [supported]);

  // Tras un F5 el navegador no deja hablar hasta el primer gesto: ahí se suelta la fila.
  useEffect(() => {
    if (!needsGesture) return;
    const unlock = (): void => {
      needsGestureRef.current = false;
      setNeedsGesture(false);
      pump();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [needsGesture, pump]);

  /*
    Seguir la pestaña narrada, sólo en la ventana que habla. El hilo puede
    seguir la misma: el registro no pide el tramo final de nuevo, salvo al
    retomar tras un F5, cuando hace falta saber qué se perdió.
  */
  useEffect(() => {
    if (ownedTerminal === null) return;
    const terminalId = ownedTerminal;
    const resumed = lastSeenRef.current === null ? readLastSeen(terminalId) : null;
    if (resumed !== null) lastSeenRef.current = resumed;

    const remember = (events: readonly ConversationEvent[]): void => {
      const seen = seenRef.current;
      for (const event of events) seen.add(event.eventId);
      if (seen.size > MAX_SEEN) seenRef.current = new Set([...seen].slice(-MAX_SEEN / 2));
      const last = events[events.length - 1];
      if (last !== undefined) {
        lastSeenRef.current = last.eventId;
        writeLastSeen(terminalId, last.eventId);
      }
    };
    const speakEvents = (events: readonly ConversationEvent[]): void => {
      for (const message of narratorMessages(events, phrases())) {
        queueRef.current.push(message);
      }
      pump();
    };

    targetRef.current = terminalId;
    const off = connection.onMessage((message) => {
      // Ya se pidió narrar otra: lo que llega de esta no se anota ni se dice.
      if (targetRef.current !== terminalId) return;
      if (message.type === 'conversation.append' && message.terminalId === terminalId) {
        const fresh = message.events.filter((event) => !seenRef.current.has(event.eventId));
        remember(fresh);
        speakEvents(fresh);
      } else if (message.type === 'conversation.reset' && message.terminalId === terminalId) {
        const plan = planReset(message.events, lastSeenRef.current, seenRef.current);
        if (plan.gap) say(`gap:${Date.now()}`, t('narrator.say.gap'));
        remember(message.events);
        speakEvents(plan.fresh);
      }
    });
    const release = conversationSubscriptions(connection).acquire(terminalId, { needsSnapshot: resumed !== null });
    return () => {
      off();
      release();
    };
  }, [connection, ownedTerminal, pump, say]);

  /*
    Dejar de ser la ventana que habla, o cambiar de pestaña, corta lo que se
    decía. Sólo al dejar de serlo se olvida hasta dónde se leyó: al cargar la
    página todavía no llegó el estado, y borrarlo ahí impediría retomar tras F5.
  */
  const wasOwnedRef = useRef<TerminalId | null>(null);
  useEffect(() => {
    if (ownedTerminal === null && wasOwnedRef.current !== null) {
      lastSeenRef.current = null;
      seenRef.current = new Set();
      targetRef.current = null;
      clearLastSeen();
    }
    wasOwnedRef.current = ownedTerminal;
    return () => stopAll();
  }, [ownedTerminal, stopAll]);

  // "Te espera": el mismo cambio que hace sonar el aviso (§6.20), sólo de la pestaña narrada.
  const previousActivity = useRef<TerminalActivity | undefined>(undefined);
  useEffect(() => {
    if (ownedTerminal === null) {
      previousActivity.current = undefined;
      return;
    }
    const next = activity.get(ownedTerminal);
    const before = previousActivity.current;
    previousActivity.current = next;
    if (next === undefined) return;
    if (chimeFor(before, next) === 'attention') {
      say(`waiting:${Date.now()}`, t('narrator.say.waiting', { tab: nameOfRef.current(ownedTerminal) }));
    }
  }, [activity, ownedTerminal, say]);

  const send = useCallback(
    (next: NarratorHolder | null) => connection.send({ type: 'narrator.set', narrator: next }),
    [connection],
  );

  const startOn = useCallback(
    (terminalId: TerminalId, events: readonly ConversationEvent[]) => {
      // Lo que el hilo ya muestra no se lee: se empieza por lo próximo.
      targetRef.current = terminalId;
      seenRef.current = new Set(events.map((event) => event.eventId));
      const last = events[events.length - 1];
      lastSeenRef.current = last === undefined ? null : last.eventId;
      if (last !== undefined) writeLastSeen(terminalId, last.eventId);
      // El clic es el gesto que el navegador pide para hablar.
      needsGestureRef.current = false;
      setNeedsGesture(false);
      stopAll();
      send({ terminalId, windowId });
    },
    [send, stopAll, windowId],
  );

  const pendingEventsRef = useRef<readonly ConversationEvent[]>([]);

  const activate = useCallback(
    (terminalId: TerminalId, events: readonly ConversationEvent[]) => {
      const current = choiceRef.current;
      if (current.kind === 'missing') {
        pendingEventsRef.current = events;
        setVoicePrompt({ terminalId, fallback: current.fallback, rechecked: false });
        return;
      }
      startOn(terminalId, events);
    },
    [startOn],
  );

  const turnOff = useCallback(() => {
    stopAll();
    send(null);
  }, [send, stopAll]);

  const skip = useCallback(() => {
    const current = currentRef.current;
    if (current === null) return;
    queueRef.current.dropMessage(current.messageId);
    currentRef.current = null;
    if (speechAvailable()) window.speechSynthesis.cancel();
    pump();
  }, [pump]);

  const setVoice = useCallback((voiceURI: string | null) => {
    setSavedVoice(voiceURI);
    writeStored(NARRATOR_VOICE_STORAGE_KEY, voiceURI ?? '');
  }, []);

  const setRate = useCallback((value: number) => {
    const next = clampRate(value);
    setRateState(next);
    writeStored(NARRATOR_RATE_STORAGE_KEY, String(next));
  }, []);

  const test = useCallback(() => {
    // La prueba no espera la fila: la corta, y lo que faltaba se pierde, como con "Callar".
    stopAll();
    needsGestureRef.current = false;
    setNeedsGesture(false);
    say(`test:${Date.now()}`, t('narrator.say.sample'));
  }, [say, stopAll]);

  const recheckVoices = useCallback(() => {
    if (!speechAvailable() || voicePrompt === null) return;
    const list = window.speechSynthesis.getVoices().map(toVoiceInfo);
    setRawVoices(list);
    const next = pickVoice(list, { saved: savedVoice, uiLocale: getLocale(), browserLanguages: navigator.languages ?? [] });
    if (next.kind === 'voice') {
      choiceRef.current = next;
      setVoicePrompt(null);
      startOn(voicePrompt.terminalId, pendingEventsRef.current);
      return;
    }
    setVoicePrompt({ ...voicePrompt, fallback: next.fallback, rechecked: true });
  }, [savedVoice, startOn, voicePrompt]);

  const useFallback = useCallback(() => {
    if (voicePrompt === null || voicePrompt.fallback === null) return;
    const fallback = voicePrompt.fallback;
    setVoice(fallback.voiceURI);
    choiceRef.current = { kind: 'voice', voice: fallback };
    setVoicePrompt(null);
    startOn(voicePrompt.terminalId, pendingEventsRef.current);
  }, [setVoice, startOn, voicePrompt]);

  const closePrompt = useCallback(() => setVoicePrompt(null), []);

  return {
    available: supported && serverHasNarrator,
    voicesKnown,
    hasLocalVoice: localVoices(rawVoices).length > 0,
    holder,
    isOwner,
    speaking,
    pending,
    needsGesture: needsGesture && isOwner && speaking,
    choice,
    voices,
    savedVoice,
    rate,
    platform,
    voicePrompt,
    activate,
    turnOff,
    skip,
    silence: stopAll,
    setVoice,
    setRate,
    test,
    recheckVoices,
    useFallback,
    closePrompt,
  };
}
