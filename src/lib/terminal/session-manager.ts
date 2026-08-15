import { AppState, Platform, type AppStateStatus } from 'react-native';

import { getTeleportClient, type TeleportClient } from '@/lib/teleport/client';
import { saveSessionSnapshot } from '@/lib/teleport/profile-store';
import type { TerminalModifiers } from '@/lib/terminal/keys';
import type {
  SessionTarget,
  TerminalEvent,
  TerminalOutputSnapshot,
} from '@/types/teleport';

export type TerminalConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'checking'
  | 'reconnecting'
  | 'closed'
  | 'error';

export type TerminalSessionSnapshot = {
  target?: SessionTarget;
  sessionId: string;
  state: TerminalConnectionState;
  error: string;
  alternateScreen: boolean;
  mouseTracking: boolean;
  terminalTitle: string;
  fallbackText: string;
};

type Size = { columns: number; rows: number };
type Listener = (snapshot: TerminalSessionSnapshot) => void;

const INITIAL_SIZE: Size = { columns: 84, rows: 40 };
const RESIZE_SETTLE_MS = 300;

class TerminalSessionManager {
  private readonly client: TeleportClient;
  private listeners = new Set<Listener>();
  private target?: SessionTarget;
  private sessionId = '';
  private state: TerminalConnectionState = 'idle';
  private error = '';
  private alternateScreen = false;
  private mouseTracking = false;
  private terminalTitle = '';
  private bracketedPaste = false;
  private fallbackText = '';
  private lastSequence = 0;
  private size = INITIAL_SIZE;
  private connectionAttempt = 0;
  private outputSync?: {
    sessionId: string;
    promise: Promise<TerminalOutputSnapshot>;
  };
  private queuedEvents: Extract<TerminalEvent, { type: 'data' }>[] = [];
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private previousAppState: AppStateStatus | null = AppState.currentState;
  private resumePending = false;

  constructor() {
    this.client = getTeleportClient();
    this.client.subscribe(event => this.handleEvent(event));
    AppState.addEventListener('change', nextState => this.handleAppState(nextState));
  }

  getSnapshot = (): TerminalSessionSnapshot => ({
    target: this.target,
    sessionId: this.sessionId,
    state: this.state,
    error: this.error,
    alternateScreen: this.alternateScreen,
    mouseTracking: this.mouseTracking,
    terminalTitle: this.terminalTitle,
    fallbackText: this.fallbackText,
  });

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  };

  attach(target: SessionTarget, size: Size) {
    this.size = size;
    if (this.target && sameTarget(this.target, target)) {
      this.target = { ...target, ...size };
      this.resize(size.columns, size.rows);
      if (this.sessionId && this.state !== 'closed' && this.state !== 'error') {
        void this.checkExistingSession();
      } else if (this.state !== 'connecting' && this.state !== 'reconnecting') {
        void this.connect('initial');
      }
      return;
    }

    const previousSession = this.sessionId;
    this.target = { ...target, ...size };
    this.sessionId = '';
    this.lastSequence = 0;
    this.queuedEvents = [];
    this.resetTerminalState();
    this.publish();
    if (previousSession) void this.client.closeSession(previousSession);
    void this.connect('initial');
  }

  detach() {
    // Session ownership deliberately lives below React navigation. Leaving the
    // screen only detaches its listener; it does not close the SSH session.
  }

  send(data: string) {
    if (!this.sessionId || this.state !== 'connected') {
      return Promise.reject(new Error('The terminal is not connected.'));
    }
    return this.client.writeSession(this.sessionId, data).catch(error => {
      this.setError(messageFrom(error));
      throw error;
    });
  }

  sendKey(key: string, text = '', modifiers: TerminalModifiers = { ctrl: false, alt: false }) {
    if (!this.sessionId || this.state !== 'connected') {
      return Promise.reject(new Error('The terminal is not connected.'));
    }
    return this.client.sendTerminalKey(this.sessionId, key, text, modifiers).catch(error => {
      this.setError(messageFrom(error));
      throw error;
    });
  }

  paste(data: string) {
    if (!this.sessionId || this.state !== 'connected') {
      return Promise.reject(new Error('The terminal is not connected.'));
    }
    return this.client.pasteSession(this.sessionId, data).catch(error => {
      this.setError(messageFrom(error));
      throw error;
    });
  }

  sendMouseTap(column: number, row: number) {
    if (!this.mouseTracking) {
      return Promise.resolve(false);
    }
    return this.client.sendTerminalMouseTap(this.sessionId, column, row);
  }

  sendMouseEvent(
    column: number,
    row: number,
    action: 'press' | 'motion' | 'release'
  ) {
    if (
      (!this.mouseTracking && action !== 'release')
      || !this.sessionId
      || this.state !== 'connected'
    ) {
      return Promise.resolve(false);
    }
    return this.client.sendTerminalMouseEvent(
      this.sessionId,
      column,
      row,
      action
    );
  }

  sendMouseScroll(column: number, row: number, direction: 'up' | 'down', steps: number) {
    if (!this.mouseTracking) {
      return Promise.resolve(false);
    }
    return this.client.sendTerminalMouseScroll(
      this.sessionId,
      column,
      row,
      direction,
      steps
    );
  }

  resize(columns: number, rows: number) {
    if (columns < 1 || rows < 1) return;
    this.size = { columns, rows };
    if (this.target) this.target = { ...this.target, columns, rows };
    if (!this.sessionId) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    const sessionId = this.sessionId;
    this.resizeTimer = setTimeout(() => {
      this.client.resizeSession(sessionId, columns, rows).catch(error => {
        if (this.sessionId === sessionId) this.setError(messageFrom(error));
      });
    }, RESIZE_SETTLE_MS);
  }

  async disconnect() {
    this.connectionAttempt += 1;
    const sessionId = this.sessionId;
    this.sessionId = '';
    this.state = 'closed';
    this.error = '';
    this.publish();
    try {
      if (sessionId) await this.client.closeSession(sessionId);
    } finally {
      await this.persistSessionSnapshot();
    }
  }

  private async connect(mode: 'initial' | 'resume') {
    if (!this.target || !isAppActive(AppState.currentState)) return;
    const attempt = ++this.connectionAttempt;
    const staleSession = this.sessionId;
    this.sessionId = '';
    this.lastSequence = 0;
    this.queuedEvents = [];
    this.resetTerminalState();
    this.state = mode === 'resume' ? 'reconnecting' : 'connecting';
    this.error = '';
    this.publish();
    if (staleSession) void this.client.closeSession(staleSession);

    try {
      const target = { ...this.target, ...this.size };
      const session = await this.client.openSession(target);
      void this.persistSessionSnapshot();
      if (
        attempt !== this.connectionAttempt
        || !isAppActive(AppState.currentState)
        || !this.target
        || !sameTarget(this.target, target)
      ) {
        void this.client.closeSession(session.id);
        return;
      }

      this.sessionId = session.id;
      this.state = 'checking';
      this.publish();
      const output = await this.syncOutput(session.id);
      if (attempt !== this.connectionAttempt || this.sessionId !== session.id) return;
      if (!output.open) {
        throw new Error(output.error || output.reason || 'The terminal closed while connecting.');
      }
      await this.client.resizeSession(session.id, this.size.columns, this.size.rows);
      this.state = 'connected';
      this.error = '';
      this.publish();
      void this.client.sendTerminalFocus(session.id, true).catch(() => undefined);
    } catch (error) {
      if (attempt !== this.connectionAttempt) return;
      this.sessionId = '';
      this.state = 'error';
      this.error = messageFrom(error);
      this.publish();
    }
  }

  private async checkExistingSession() {
    const sessionId = this.sessionId;
    if (!isAppActive(AppState.currentState)) return;
    if (!sessionId) {
      if (this.target) await this.connect('resume');
      return;
    }
    this.state = 'checking';
    this.publish();
    try {
      const output = await this.syncOutput(sessionId);
      if (this.sessionId !== sessionId) return;
      if (!output.open) throw new Error(output.error || output.reason || 'Session closed.');
      await this.client.pingSession(sessionId);
      await this.client.resizeSession(sessionId, this.size.columns, this.size.rows);
      if (this.sessionId !== sessionId) return;
      this.state = 'connected';
      this.error = '';
      this.publish();
      void this.client.sendTerminalFocus(sessionId, true).catch(() => undefined);
    } catch {
      if (this.sessionId !== sessionId) return;
      await this.connect('resume');
    }
  }

  private syncOutput(sessionId: string): Promise<TerminalOutputSnapshot> {
    if (this.outputSync?.sessionId === sessionId) {
      return this.outputSync.promise;
    }
    const promise = this.performOutputSync(sessionId).finally(() => {
      if (this.outputSync?.promise !== promise) return;
      this.outputSync = undefined;
      if (this.sessionId === sessionId && this.queuedEvents.length > 0) {
        void this.syncOutput(sessionId).catch(error => this.setError(messageFrom(error)));
      }
    });
    this.outputSync = { sessionId, promise };
    return promise;
  }

  private async performOutputSync(sessionId: string) {
    const output = await this.client.sessionOutput(sessionId, this.lastSequence);
    if (this.sessionId !== sessionId) return output;
    if (typeof output.alternateScreen === 'boolean') {
      this.alternateScreen = output.alternateScreen;
    }
    if (typeof output.mouseTracking === 'boolean') {
      this.mouseTracking = output.mouseTracking;
    }
    if (typeof output.bracketedPaste === 'boolean') {
      this.bracketedPaste = output.bracketedPaste;
    }
    if (typeof output.title === 'string') this.terminalTitle = output.title;
    if (output.truncated) {
      this.lastSequence = 0;
      this.resetTerminalState();
    }
    const queued = this.queuedEvents;
    this.queuedEvents = [];
    const chunks = [
      ...output.chunks,
      ...queued.map(event => ({ sequence: event.sequence, data: event.data })),
    ].sort((a, b) => a.sequence - b.sequence);
    for (const chunk of chunks) this.consumeChunk(chunk.sequence, chunk.data);
    if (output.error) this.error = output.error;
    return output;
  }

  private handleEvent(event: TerminalEvent) {
    if (!this.sessionId || event.sessionId !== this.sessionId) return;
    if (event.type === 'data') {
      this.updateModes(event);
      if (this.outputSync?.sessionId === event.sessionId) {
        this.queuedEvents.push(event);
        return;
      }
      if (event.sequence > this.lastSequence + 1) {
        this.queuedEvents.push(event);
        void this.syncOutput(event.sessionId).catch(error => this.setError(messageFrom(error)));
        return;
      }
      this.consumeChunk(event.sequence, event.data);
      return;
    }
    if (event.type === 'error') {
      this.setError(event.message);
      return;
    }
    this.state = 'closed';
    this.error = event.reason || '';
    this.publish();
  }

  private consumeChunk(sequence: number, data: string) {
    if (sequence <= this.lastSequence) return;
    this.lastSequence = sequence;
    if (Platform.OS === 'web') {
      this.fallbackText = `${this.fallbackText}${data}`.slice(-65536);
    }
    this.publish();
  }

  private handleAppState(nextState: AppStateStatus) {
    const wasActive = isAppActive(this.previousAppState);
    this.previousAppState = nextState;
    if (!isAppActive(nextState)) {
      if (wasActive) this.resumePending = true;
      if (wasActive && this.sessionId && this.state === 'connected') {
        void this.client.sendTerminalFocus(this.sessionId, false).catch(() => undefined);
      }
      return;
    }
    if (!this.resumePending) return;
    this.resumePending = false;
    void this.checkExistingSession();
  }

  private resetTerminalState() {
    this.alternateScreen = false;
    this.mouseTracking = false;
    this.bracketedPaste = false;
    this.terminalTitle = '';
    this.fallbackText = '';
  }

  private updateModes(event: Extract<TerminalEvent, { type: 'data' }>) {
    if (typeof event.alternateScreen === 'boolean') {
      this.alternateScreen = event.alternateScreen;
    }
    if (typeof event.mouseTracking === 'boolean') {
      this.mouseTracking = event.mouseTracking;
    }
    if (typeof event.bracketedPaste === 'boolean') {
      this.bracketedPaste = event.bracketedPaste;
    }
    if (typeof event.title === 'string') this.terminalTitle = event.title;
  }

  private setError(error: string) {
    this.error = error;
    this.publish();
  }

  private async persistSessionSnapshot() {
    try {
      await saveSessionSnapshot(await this.client.exportSession());
    } catch {
      // Terminal teardown must not become a logout path. Resource screens
      // surface a genuinely expired or rejected Teleport session.
    }
  }

  private publish() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }
}

let singleton: TerminalSessionManager | undefined;

export function getTerminalSessionManager() {
  singleton ??= new TerminalSessionManager();
  return singleton;
}

function sameTarget(left: SessionTarget, right: SessionTarget) {
  return left.serverId === right.serverId
    && left.hostname === right.hostname
    && left.login === right.login;
}

function isAppActive(state: AppStateStatus | null) {
  return state === null || state === 'active';
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
