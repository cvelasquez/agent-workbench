/**
 * Los controles del narrador (hito 57, §6.40): el botón de la barra del hilo,
 * el parlante de la pestaña narrada, el aviso de la voz que falta, el cartel
 * tras un F5 y la sección de Ajustes. Lo que hacen vive en `useNarrator.ts`.
 */

import { useEffect } from 'react';
import type { ConversationEvent, TerminalId } from '@agent-workbench/shared';
import { getLocale, t, type MessageKey } from './i18n/index.js';
import { baseLanguage, MAX_RATE, MIN_RATE, RATE_STEP, type VoicePlatform } from './narrator-voices.js';
import type { NarratorState } from './useNarrator.js';

const STEPS: Readonly<Record<VoicePlatform, MessageKey>> = {
  windows: 'narrator.steps.windows',
  mac: 'narrator.steps.mac',
  linux: 'narrator.steps.linux',
  other: 'narrator.steps.other',
};

/** Cómo se instala una voz en el sistema de este navegador. Sólo texto: la app no abre nada. */
export function narratorSteps(platform: VoicePlatform): string {
  return t(STEPS[platform]);
}

/** El idioma del usuario, con su nombre en el idioma de la interfaz ("español", "French"). */
export function narratorLanguageName(): string {
  const locale = getLocale();
  const base = baseLanguage(locale);
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(base) ?? base;
  } catch {
    return base;
  }
}

export function NarratorIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SkipIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path d="M5 6l8 6-8 6zM14 6l8 6-8 6z" fill="currentColor" />
    </svg>
  );
}

interface NarratorButtonProps {
  narrator: NarratorState;
  /** La pestaña que se mira, que es la que el botón enciende. */
  terminalId: TerminalId;
  /** Lo que el hilo ya muestra de ella: no se lee. */
  events: readonly ConversationEvent[];
  nameOf: (terminalId: TerminalId) => string;
}

/** El botón de la barra del hilo, y "Saltar" mientras habla. */
export function NarratorButton({ narrator, terminalId, events, nameOf }: NarratorButtonProps): JSX.Element | null {
  if (!narrator.available) return null;

  if (narrator.voicesKnown && !narrator.hasLocalVoice) {
    const title = t('narrator.button.noVoices', { steps: narratorSteps(narrator.platform) });
    return (
      <button className="icon-button narrator-button" disabled title={title} aria-label={title}>
        <NarratorIcon />
      </button>
    );
  }

  const holder = narrator.holder;
  const here = holder !== null && holder.terminalId === terminalId;
  const ownHere = here && narrator.isOwner;
  let title: string;
  let onClick: () => void;
  if (ownHere) {
    title = t('narrator.button.off');
    onClick = narrator.turnOff;
  } else if (here) {
    title = t('narrator.button.elsewhere');
    onClick = () => narrator.activate(terminalId, events);
  } else if (holder !== null) {
    title = t('narrator.button.move', { tab: nameOf(holder.terminalId) });
    onClick = () => narrator.activate(terminalId, events);
  } else {
    title = t('narrator.button.on');
    onClick = () => narrator.activate(terminalId, events);
  }

  return (
    <>
      <button
        className={`icon-button narrator-button${ownHere ? ' icon-button-on' : ''}${here && !ownHere ? ' narrator-elsewhere' : ''}`}
        onClick={onClick}
        title={title}
        aria-label={title}
        aria-pressed={ownHere}
      >
        <NarratorIcon />
      </button>
      {ownHere && narrator.speaking && (
        <button className="icon-button narrator-skip" onClick={narrator.skip} title={t('narrator.skip')} aria-label={t('narrator.skip')}>
          <SkipIcon />
        </button>
      )}
    </>
  );
}

interface NarratorTabBadgeProps {
  narrator: NarratorState;
  terminalId: TerminalId;
  /** En la lista del teléfono va adentro de otro botón: ahí sólo se dibuja. */
  interactive: boolean;
}

/**
 * El parlante chico de la pestaña narrada, en la barra de pestañas: se sabe
 * cuál habla sin abrirla. En la ventana que habla, con algo sonando, el clic
 * calla: es lo que se alcanza desde cualquier pestaña.
 */
export function NarratorTabBadge({ narrator, terminalId, interactive }: NarratorTabBadgeProps): JSX.Element | null {
  const holder = narrator.holder;
  if (!narrator.available || holder === null || holder.terminalId !== terminalId) return null;
  const silenceable = interactive && narrator.isOwner && narrator.speaking;
  const title = !narrator.isOwner
    ? t('narrator.tab.elsewhere')
    : silenceable
      ? t('narrator.tab.silence')
      : t('narrator.tab.idle');
  return (
    <span
      className={`tab-narrator${narrator.isOwner ? '' : ' tab-narrator-elsewhere'}${silenceable ? ' tab-narrator-live' : ''}`}
      title={title}
      aria-label={title}
      role={silenceable ? 'button' : undefined}
      onClick={
        silenceable
          ? (event) => {
              event.stopPropagation();
              narrator.silence();
            }
          : undefined
      }
    >
      <NarratorIcon size={11} />
    </span>
  );
}

/** Tras un F5 el navegador no deja hablar hasta un clic: cualquiera sirve. */
export function NarratorGestureChip({ narrator }: { narrator: NarratorState }): JSX.Element | null {
  if (!narrator.needsGesture) return null;
  return (
    <button className="narrator-gesture" onClick={() => undefined}>
      <NarratorIcon size={12} />
      <span>{t('narrator.gesture')}</span>
    </button>
  );
}

/** El aviso de la voz que falta, al encender el narrador. */
export function NarratorVoiceDialog({ narrator }: { narrator: NarratorState }): JSX.Element | null {
  const prompt = narrator.voicePrompt;
  const close = narrator.closePrompt;
  useEffect(() => {
    if (prompt === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [prompt, close]);
  if (prompt === null) return null;

  const language = narratorLanguageName();
  const title = t('narrator.prompt.title', { language });
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal worktree-dialog" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-button" onClick={close} title={t('common.close')}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <p className="modal-hint">
            {t('narrator.prompt.body', { language, steps: narratorSteps(narrator.platform) })}
          </p>
          <p className={`modal-hint${prompt.rechecked ? ' narrator-recheck' : ''}`}>{t('narrator.prompt.restart')}</p>
          <div className="worktree-actions">
            <button className="link-button" onClick={close}>
              {t('common.cancel')}
            </button>
            {prompt.fallback !== null && (
              <button className="link-button" onClick={narrator.useFallback}>
                {t('narrator.prompt.useFallback', { voice: prompt.fallback.name })}
              </button>
            )}
            <button className="primary-button" onClick={narrator.recheckVoices} autoFocus>
              {t('narrator.prompt.recheck')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** La sección de Ajustes: la voz, la velocidad y una prueba. */
export function NarratorSettings({ narrator }: { narrator: NarratorState }): JSX.Element | null {
  if (!narrator.available) return null;
  const language = narratorLanguageName();
  const automatic =
    narrator.savedVoice === null && narrator.choice.kind === 'voice'
      ? t('settings.narrator.voiceAuto', { voice: narrator.choice.voice.name })
      : t('settings.narrator.voiceAutoNone', { language });
  const savedMissing = narrator.savedVoice !== null && !narrator.voices.some((voice) => voice.voiceURI === narrator.savedVoice);
  return (
    <>
      <h3 className="modal-section">{t('settings.section.narrator')}</h3>
      <div className="settings-row">
        <span className="settings-label">{t('settings.narrator.voice')}</span>
        <select
          className="narrator-voice-select"
          value={narrator.savedVoice === null || savedMissing ? '' : narrator.savedVoice}
          onChange={(event) => narrator.setVoice(event.target.value === '' ? null : event.target.value)}
          disabled={narrator.voices.length === 0}
        >
          <option value="">{automatic}</option>
          {narrator.voices.map((voice) => (
            <option key={voice.voiceURI} value={voice.voiceURI}>
              {voice.name}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-row">
        <span className="settings-label">{t('settings.narrator.rate')}</span>
        <input
          className="narrator-rate"
          type="range"
          min={MIN_RATE}
          max={MAX_RATE}
          step={RATE_STEP}
          value={narrator.rate}
          onChange={(event) => narrator.setRate(Number(event.target.value))}
          aria-label={t('settings.narrator.rate')}
        />
        <span className="narrator-rate-value">{`${narrator.rate.toFixed(1)}×`}</span>
        <button className="primary-button primary-button-small" onClick={narrator.test} disabled={!narrator.hasLocalVoice}>
          {t('settings.narrator.test')}
        </button>
      </div>
      {narrator.choice.kind === 'missing' && narrator.savedVoice === null && (
        <p className="modal-hint">{t('settings.narrator.missing', { language, steps: narratorSteps(narrator.platform) })}</p>
      )}
      <p className="modal-hint">{t('settings.narrator.hint')}</p>
    </>
  );
}
