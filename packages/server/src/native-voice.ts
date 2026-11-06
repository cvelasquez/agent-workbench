import type { NativeVoiceCapability, NativeVoiceControl, NativeVoiceMode, TerminalId } from '@agent-workbench/shared';

const SPACE_REPEAT_MS = 35;
const F8 = '\u001b[19~';

interface VoiceSession {
  owner: object;
  mode: NativeVoiceMode;
  control: NativeVoiceControl;
  timer: unknown | null;
  pending: boolean;
}

export type VoiceStopResult = 'none' | 'pending' | 'recorded' | 'cancelled';

export interface NativeVoiceControllerOptions {
  capabilityOf: (terminalId: TerminalId) => NativeVoiceCapability | null;
  isAlive: (terminalId: TerminalId) => boolean;
  write: (terminalId: TerminalId, data: string) => boolean;
  repeatEvery?: (callback: () => void, ms: number) => unknown;
  stopRepeating?: (timer: unknown) => void;
}

/** Acciones acotadas a los flujos de voz que declaran los adaptadores. */
export class NativeVoiceController {
  private readonly sessions = new Map<TerminalId, VoiceSession>();
  private readonly repeatEvery: (callback: () => void, ms: number) => unknown;
  private readonly stopRepeating: (timer: unknown) => void;

  constructor(private readonly options: NativeVoiceControllerOptions) {
    this.repeatEvery = options.repeatEvery ?? ((callback, ms) => setInterval(callback, ms));
    this.stopRepeating = options.stopRepeating ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  }

  async start(
    terminalId: TerminalId,
    owner: object,
    mode: NativeVoiceMode,
    canStart?: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    if (!this.options.isAlive(terminalId)) return false;
    const current = this.sessions.get(terminalId);
    if (current !== undefined) return current.owner === owner && current.mode === mode;

    const capability = this.options.capabilityOf(terminalId);
    const control = capability?.modes.find((item) => item.mode === mode)?.control;
    if (control === undefined) return false;

    const session: VoiceSession = { owner, mode, control, timer: null, pending: true };
    this.sessions.set(terminalId, session);
    let allowed = true;
    if (canStart !== undefined) {
      try {
        allowed = await canStart();
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      if (this.sessions.get(terminalId) === session) this.sessions.delete(terminalId);
      return false;
    }
    if (this.sessions.get(terminalId) !== session) return false;
    if (!this.options.isAlive(terminalId)) {
      this.sessions.delete(terminalId);
      return false;
    }
    if (!this.startControl(terminalId, session)) {
      this.sessions.delete(terminalId);
      return false;
    }
    session.pending = false;
    return true;
  }

  /**
   * Detiene la voz de esa terminal y dice que habia: `recorded` estaba grabando
   * (y no se cancelo: hay un dictado que recoger, §5.3.3); `cancelled`, se
   * descarto; `pending`, ni habia empezado; `none`, no era de ese socket o modo.
   */
  stopRecording(terminalId: TerminalId, owner: object, mode: NativeVoiceMode, cancel = false): VoiceStopResult {
    const session = this.sessions.get(terminalId);
    if (session === undefined || session.owner !== owner || session.mode !== mode) return 'none';
    if (session.pending) {
      this.sessions.delete(terminalId);
      return 'pending';
    }
    this.finish(terminalId, session, cancel);
    return cancel ? 'cancelled' : 'recorded';
  }

  stop(terminalId: TerminalId, owner: object, mode: NativeVoiceMode, cancel = false): boolean {
    return this.stopRecording(terminalId, owner, mode, cancel) !== 'none';
  }

  releaseSocket(owner: object): void {
    for (const [terminalId, session] of this.sessions) {
      if (session.owner === owner) this.finish(terminalId, session, true);
    }
  }

  releaseTerminal(terminalId: TerminalId): void {
    const session = this.sessions.get(terminalId);
    if (session !== undefined) this.finish(terminalId, session, true);
  }

  isActive(terminalId: TerminalId): boolean {
    return this.sessions.has(terminalId);
  }

  dispose(): void {
    for (const [terminalId, session] of this.sessions) this.finish(terminalId, session, true);
  }

  private startControl(terminalId: TerminalId, session: VoiceSession): boolean {
    switch (session.control) {
      case 'claude-hold-space':
        if (!this.options.write(terminalId, ' ')) return false;
        session.timer = this.repeatEvery(() => {
          if (this.sessions.get(terminalId) !== session) return;
          if (!this.options.isAlive(terminalId) || !this.options.write(terminalId, ' ')) {
            this.finish(terminalId, session, false);
          }
        }, SPACE_REPEAT_MS);
        return true;
      case 'antigravity-dictation':
        return this.options.write(terminalId, '/voice dictate\r');
      case 'antigravity-live':
        return this.options.write(terminalId, '/voice live\r');
      case 'codex-live-f8':
        return this.options.write(terminalId, F8);
    }
  }

  private finish(terminalId: TerminalId, session: VoiceSession, cancel: boolean): void {
    if (this.sessions.get(terminalId) !== session) return;
    this.sessions.delete(terminalId);
    if (session.pending) return;
    if (session.timer !== null) {
      this.stopRepeating(session.timer);
      session.timer = null;
    }

    let data = '';
    switch (session.control) {
      case 'claude-hold-space':
        if (cancel) data = '\u001b';
        break;
      case 'antigravity-dictation':
        data = cancel ? '\u001b' : '\r';
        break;
      case 'antigravity-live':
        data = '/voice stop\r';
        break;
      case 'codex-live-f8':
        data = F8;
        break;
    }
    if (data !== '') this.options.write(terminalId, data);
  }
}
