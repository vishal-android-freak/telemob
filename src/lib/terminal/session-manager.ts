import { AppState, Platform, type AppStateStatus } from 'react-native';

import { getTeleportClient, type TeleportClient } from '@/lib/teleport/client';
import {
  refreshSavedProfile,
  withSavedProfile,
} from '@/lib/teleport/profile-session';
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
  tabId: string;
  profileId: string;
  target: SessionTarget;
  sessionId: string;
  state: TerminalConnectionState;
  error: string;
  alternateScreen: boolean;
  mouseTracking: boolean;
  terminalTitle: string;
  fallbackText: string;
  unread: boolean;
};

export type TerminalWorkspaceSnapshot = {
  activeTabId?: string;
  tabs: TerminalSessionSnapshot[];
};

type Size = { columns: number; rows: number };
type SessionListener = (snapshot: TerminalSessionSnapshot) => void;
type WorkspaceListener = (snapshot: TerminalWorkspaceSnapshot) => void;
type SessionIdentity = Omit<SessionTarget, 'columns' | 'rows' | 'tabId' | 'profileId'>;

const INITIAL_SIZE: Size = { columns: 84, rows: 40 };
const RESIZE_SETTLE_MS = 300;

export class TerminalSessionController {
  private listeners = new Set<SessionListener>();
  private sessionId = '';
  private state: TerminalConnectionState = 'idle';
  private error = '';
  private alternateScreen = false;
  private mouseTracking = false;
  private terminalTitle = '';
  private bracketedPaste = false;
  private fallbackText = '';
  private unread = false;
  private lastSequence = 0;
  private size: Size = INITIAL_SIZE;
  private connectionAttempt = 0;
  private started = false;
  private outputSync?: {
    sessionId: string;
    promise: Promise<TerminalOutputSnapshot>;
  };
  private queuedEvents: Extract<TerminalEvent, { type: 'data' }>[] = [];
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private resumePending = false;

  constructor(
    readonly tabId: string,
    readonly profileId: string,
    private target: SessionTarget,
    private readonly client: TeleportClient,
    private readonly workspace: TerminalWorkspaceManager
  ) {}

  getSnapshot = (): TerminalSessionSnapshot => ({
    tabId: this.tabId,
    profileId: this.profileId,
    target: this.target,
    sessionId: this.sessionId,
    state: this.state,
    error: this.error,
    alternateScreen: this.alternateScreen,
    mouseTracking: this.mouseTracking,
    terminalTitle: this.terminalTitle,
    fallbackText: this.fallbackText,
    unread: this.unread,
  });

  subscribe = (listener: SessionListener) => {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  };

  attach(size: Size) {
    this.size = size;
    this.target = { ...this.target, ...size };
    this.workspace.activate(this.tabId);
    if (!this.started) {
      this.started = true;
      void this.connect('initial');
      return;
    }
    this.resize(size.columns, size.rows);
    if (this.sessionId && this.state !== 'closed' && this.state !== 'error') {
      void this.checkExistingSession();
    } else if (this.state !== 'connecting' && this.state !== 'reconnecting') {
      void this.connect('resume');
    }
  }

  detach() {
    // The workspace owns the SSH session. Unmounting a terminal view only
    // detaches that view and leaves the connection available to its tab.
  }

  markActive() {
    if (!this.unread) return;
    this.unread = false;
    this.publish();
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

  sendKey(
    key: string,
    text = '',
    modifiers: TerminalModifiers = { ctrl: false, alt: false },
    action: 'press' | 'repeat' | 'release' = 'press'
  ) {
    if (!this.sessionId || this.state !== 'connected') {
      return Promise.reject(new Error('The terminal is not connected.'));
    }
    return this.client.sendTerminalKey(this.sessionId, key, text, modifiers, action).catch(error => {
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
    if (!this.mouseTracking) return Promise.resolve(false);
    return this.client.sendTerminalMouseTap(this.sessionId, column, row);
  }

  sendMouseEvent(column: number, row: number, action: 'press' | 'motion' | 'release') {
    if (
      (!this.mouseTracking && action !== 'release')
      || !this.sessionId
      || this.state !== 'connected'
    ) {
      return Promise.resolve(false);
    }
    return this.client.sendTerminalMouseEvent(this.sessionId, column, row, action);
  }

  sendMouseScroll(column: number, row: number, direction: 'up' | 'down', steps: number) {
    if (!this.mouseTracking) return Promise.resolve(false);
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
    this.target = { ...this.target, columns, rows };
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
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    this.resumePending = false;
    this.sessionId = '';
    this.lastSequence = 0;
    this.queuedEvents = [];
    this.outputSync = undefined;
    this.resetTerminalState();
    this.state = 'closed';
    this.error = '';
    this.publish();
    try {
      if (sessionId) await this.client.closeSession(sessionId);
    } finally {
      await refreshSavedProfile(this.profileId).catch(() => undefined);
    }
  }

  handleEvent(event: TerminalEvent) {
    if (!this.sessionId || event.sessionId !== this.sessionId) return;
    if (event.type === 'data') {
      this.updateModes(event);
      if (!this.workspace.isActive(this.tabId)) this.unread = true;
      if (this.outputSync?.sessionId === event.sessionId) {
        this.queuedEvents.push(event);
        this.publish();
        return;
      }
      if (event.sequence > this.lastSequence + 1) {
        this.queuedEvents.push(event);
        this.publish();
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

  handleAppState(previous: AppStateStatus | null, next: AppStateStatus) {
    const wasActive = isAppActive(previous);
    if (!isAppActive(next)) {
      if (wasActive) this.resumePending = true;
      if (
        wasActive
        && this.workspace.isActive(this.tabId)
        && this.sessionId
        && this.state === 'connected'
      ) {
        this.focus(false);
      }
      return;
    }
    if (!this.resumePending) return;
    this.resumePending = false;
    void this.checkExistingSession();
  }

  focus(focused: boolean) {
    if (!this.sessionId || this.state !== 'connected') return;
    void this.client.sendTerminalFocus(this.sessionId, focused).catch(() => undefined);
  }

  dispose() {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.listeners.clear();
  }

  private async connect(mode: 'initial' | 'resume') {
    if (!isAppActive(AppState.currentState)) return;
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
      const target = {
        ...this.target,
        ...this.size,
        tabId: this.tabId,
        profileId: this.profileId,
      };
      const session = await withSavedProfile(
        this.profileId,
        client => client.openSession(target)
      );
      if (attempt !== this.connectionAttempt || !isAppActive(AppState.currentState)) {
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
      if (this.workspace.isActive(this.tabId)) this.focus(true);
    } catch (error) {
      if (attempt !== this.connectionAttempt) return;
      this.sessionId = '';
      this.state = 'error';
      this.error = messageFrom(error);
      this.publish();
    }
  }

  private async checkExistingSession() {
    if (!this.started || !isAppActive(AppState.currentState)) return;
    const sessionId = this.sessionId;
    if (!sessionId) {
      await this.connect('resume');
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
      if (this.workspace.isActive(this.tabId)) this.focus(true);
    } catch {
      if (this.sessionId !== sessionId) return;
      await this.connect('resume');
    }
  }

  private syncOutput(sessionId: string): Promise<TerminalOutputSnapshot> {
    if (this.outputSync?.sessionId === sessionId) return this.outputSync.promise;
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
    if (typeof output.alternateScreen === 'boolean') this.alternateScreen = output.alternateScreen;
    if (typeof output.mouseTracking === 'boolean') this.mouseTracking = output.mouseTracking;
    if (typeof output.bracketedPaste === 'boolean') this.bracketedPaste = output.bracketedPaste;
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
    ].sort((left, right) => left.sequence - right.sequence);
    for (const chunk of chunks) this.consumeChunk(chunk.sequence, chunk.data);
    if (output.error) this.error = output.error;
    return output;
  }

  private consumeChunk(sequence: number, data: string) {
    if (sequence <= this.lastSequence) return;
    this.lastSequence = sequence;
    if (Platform.OS === 'web') {
      this.fallbackText = `${this.fallbackText}${data}`.slice(-65536);
    }
    this.publish();
  }

  private resetTerminalState() {
    this.alternateScreen = false;
    this.mouseTracking = false;
    this.bracketedPaste = false;
    this.terminalTitle = '';
    this.fallbackText = '';
  }

  private updateModes(event: Extract<TerminalEvent, { type: 'data' }>) {
    if (typeof event.alternateScreen === 'boolean') this.alternateScreen = event.alternateScreen;
    if (typeof event.mouseTracking === 'boolean') this.mouseTracking = event.mouseTracking;
    if (typeof event.bracketedPaste === 'boolean') this.bracketedPaste = event.bracketedPaste;
    if (typeof event.title === 'string') this.terminalTitle = event.title;
  }

  private setError(error: string) {
    this.error = error;
    this.publish();
  }

  private publish() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
    this.workspace.publish();
  }
}

export class TerminalWorkspaceManager {
  private readonly client = getTeleportClient();
  private readonly tabs = new Map<string, TerminalSessionController>();
  private readonly listeners = new Set<WorkspaceListener>();
  private activeTabId?: string;
  private previousAppState: AppStateStatus | null = AppState.currentState;

  constructor() {
    this.client.subscribe(event => this.handleEvent(event));
    AppState.addEventListener('change', nextState => this.handleAppState(nextState));
  }

  getSnapshot = (): TerminalWorkspaceSnapshot => ({
    activeTabId: this.activeTabId,
    tabs: [...this.tabs.values()].map(tab => tab.getSnapshot()),
  });

  subscribe = (listener: WorkspaceListener) => {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  };

  createSession(profileId: string, target: SessionIdentity) {
    const tabId = createTabId();
    const controller = new TerminalSessionController(
      tabId,
      profileId,
      { ...target, ...INITIAL_SIZE, tabId, profileId },
      this.client,
      this
    );
    this.tabs.set(tabId, controller);
    this.activate(tabId);
    this.publish();
    return controller;
  }

  findSession(profileId: string, serverId: string, login: string) {
    return [...this.tabs.values()].find(tab => {
      const snapshot = tab.getSnapshot();
      return snapshot.profileId === profileId
        && snapshot.target.serverId === serverId
        && snapshot.target.login === login
        && isActiveTerminalState(snapshot.state);
    });
  }

  getSession(tabId: string) {
    return this.tabs.get(tabId);
  }

  activate(tabId: string) {
    const next = this.tabs.get(tabId);
    if (!next) return false;
    if (this.activeTabId !== tabId) {
      if (this.activeTabId) this.tabs.get(this.activeTabId)?.focus(false);
      this.activeTabId = tabId;
      next.focus(true);
    }
    next.markActive();
    this.publish();
    return true;
  }

  isActive(tabId: string) {
    return this.activeTabId === tabId;
  }

  async disconnect(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return this.activeTabId;
    await tab.disconnect();
    return this.remove(tabId);
  }

  async disconnectProfile(profileId: string) {
    const tabIds = [...this.tabs.values()]
      .filter(tab => tab.profileId === profileId)
      .map(tab => tab.tabId);
    await Promise.all(tabIds.map(tabId => this.tabs.get(tabId)?.disconnect()));
    for (const tabId of tabIds) this.remove(tabId, false);
    this.publish();
  }

  dismiss(tabId: string) {
    return this.remove(tabId);
  }

  publish() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }

  private remove(tabId: string, notify = true) {
    const ordered = [...this.tabs.keys()];
    const removedIndex = ordered.indexOf(tabId);
    this.tabs.get(tabId)?.dispose();
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()];
      this.activeTabId = remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)];
      if (this.activeTabId) this.tabs.get(this.activeTabId)?.markActive();
    }
    if (notify) this.publish();
    return this.activeTabId;
  }

  private handleEvent(event: TerminalEvent) {
    for (const tab of this.tabs.values()) {
      if (tab.getSnapshot().sessionId === event.sessionId) {
        tab.handleEvent(event);
        return;
      }
    }
  }

  private handleAppState(nextState: AppStateStatus) {
    const previous = this.previousAppState;
    this.previousAppState = nextState;
    for (const tab of this.tabs.values()) tab.handleAppState(previous, nextState);
  }
}

let singleton: TerminalWorkspaceManager | undefined;

export function getTerminalWorkspaceManager() {
  singleton ??= new TerminalWorkspaceManager();
  return singleton;
}

export function isActiveTerminalState(state: TerminalConnectionState) {
  return state === 'connecting'
    || state === 'connected'
    || state === 'checking'
    || state === 'reconnecting';
}

function createTabId() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAppActive(state: AppStateStatus | null) {
  return state === null || state === 'active';
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
