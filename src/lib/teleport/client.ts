import { Platform } from 'react-native';

import type {
  AuthChallenge,
  AuthenticatedProfile,
  LoginRequest,
  SessionHandle,
  SessionTarget,
  TeleportCapabilities,
  TeleportServer,
  TerminalEvent,
  TerminalOutputSnapshot,
} from '@/types/teleport';

export interface TeleportClient {
  capabilities(): Promise<TeleportCapabilities>;
  exportSession(): Promise<string>;
  restoreSession(snapshotJson: string): Promise<AuthenticatedProfile>;
  logout(): Promise<void>;
  beginLogin(request: LoginRequest): Promise<AuthChallenge>;
  finishTotp(challengeId: string, code: string): Promise<AuthenticatedProfile>;
  finishPasskey(
    challengeId: string,
    credentialJson?: string
  ): Promise<AuthenticatedProfile>;
  listServers(): Promise<TeleportServer[]>;
  openSession(target: SessionTarget): Promise<SessionHandle>;
  writeSession(sessionId: string, data: string): Promise<void>;
  resizeSession(
    sessionId: string,
    columns: number,
    rows: number
  ): Promise<void>;
  pingSession(sessionId: string): Promise<void>;
  sessionOutput(
    sessionId: string,
    afterSequence: number
  ): Promise<TerminalOutputSnapshot>;
  closeSession(sessionId: string): Promise<void>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
}

let singleton: TeleportClient | undefined;

export function getTeleportClient(): TeleportClient {
  singleton ??= createClient();
  return singleton;
}

function createClient(): TeleportClient {
  const nativeCoreEnabled =
    process.env.EXPO_PUBLIC_TELEPORT_NATIVE_CORE !== '0';

  if (nativeCoreEnabled && (Platform.OS === 'ios' || Platform.OS === 'android')) {
    try {
      // The generated Expo module exists before the Go artifact is linked. It
      // reports that state explicitly so the same app can run in UI-only mode.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const native = require('../../../modules/expo-teleport').default;
      if (native?.getCapabilitiesAsync) {
        return new NativeTeleportClient(native);
      }
    } catch {
      // Development web builds and Expo Go use the deterministic driver below.
    }
  }
  return new DevelopmentTeleportClient();
}

type NativeModuleShape = {
  getCapabilitiesAsync(): Promise<string>;
  exportSessionAsync(): Promise<string>;
  restoreSessionAsync(snapshotJson: string): Promise<string>;
  logoutAsync(): Promise<void>;
  beginLoginAsync(requestJson: string): Promise<string>;
  finishTotpAsync(challengeId: string, code: string): Promise<string>;
  finishPasskeyAsync(
    challengeId: string,
    credentialJson: string
  ): Promise<string>;
  listServersAsync(): Promise<string>;
  openSessionAsync(targetJson: string): Promise<string>;
  writeSessionAsync(sessionId: string, data: string): Promise<void>;
  resizeSessionAsync(
    sessionId: string,
    columns: number,
    rows: number
  ): Promise<void>;
  pingSessionAsync(sessionId: string): Promise<void>;
  sessionOutputAsync(
    sessionId: string,
    afterSequence: number
  ): Promise<string>;
  closeSessionAsync(sessionId: string): Promise<void>;
  addListener(
    event: 'onTerminalEvent',
    listener: (event: TerminalEvent) => void
  ): { remove(): void };
};

class NativeTeleportClient implements TeleportClient {
  constructor(private readonly native: NativeModuleShape) {}

  async capabilities() {
    return JSON.parse(await this.native.getCapabilitiesAsync());
  }

  exportSession() {
    return this.native.exportSessionAsync();
  }

  async restoreSession(snapshotJson: string) {
    return JSON.parse(await this.native.restoreSessionAsync(snapshotJson));
  }

  logout() {
    return this.native.logoutAsync();
  }

  async beginLogin(request: LoginRequest) {
    return JSON.parse(await this.native.beginLoginAsync(JSON.stringify(request)));
  }

  async finishTotp(challengeId: string, code: string) {
    return JSON.parse(await this.native.finishTotpAsync(challengeId, code));
  }

  async finishPasskey(challengeId: string, credentialJson = '') {
    return JSON.parse(
      await this.native.finishPasskeyAsync(challengeId, credentialJson)
    );
  }

  async listServers() {
    const parsed: unknown = JSON.parse(await this.native.listServersAsync());
    if (!Array.isArray(parsed)) {
      throw new Error('Teleport returned an invalid node list.');
    }
    return parsed.map(normalizeServer);
  }

  async openSession(target: SessionTarget) {
    return JSON.parse(await this.native.openSessionAsync(JSON.stringify(target)));
  }

  writeSession(sessionId: string, data: string) {
    return this.native.writeSessionAsync(sessionId, data);
  }

  resizeSession(sessionId: string, columns: number, rows: number) {
    return this.native.resizeSessionAsync(sessionId, columns, rows);
  }

  pingSession(sessionId: string) {
    return this.native.pingSessionAsync(sessionId);
  }

  async sessionOutput(sessionId: string, afterSequence: number) {
    return JSON.parse(
      await this.native.sessionOutputAsync(sessionId, afterSequence)
    ) as TerminalOutputSnapshot;
  }

  closeSession(sessionId: string) {
    return this.native.closeSessionAsync(sessionId);
  }

  subscribe(listener: (event: TerminalEvent) => void) {
    const subscription = this.native.addListener('onTerminalEvent', listener);
    return () => subscription.remove();
  }
}

function normalizeServer(value: unknown, index: number): TeleportServer {
  const server = value && typeof value === 'object'
    ? (value as Partial<TeleportServer>)
    : {};
  return {
    id: typeof server.id === 'string' ? server.id : `node-${index}`,
    hostname:
      typeof server.hostname === 'string' && server.hostname
        ? server.hostname
        : 'Unnamed node',
    address: typeof server.address === 'string' ? server.address : 'tunnel',
    labels:
      server.labels && typeof server.labels === 'object' ? server.labels : {},
    logins: Array.isArray(server.logins)
      ? server.logins.filter((login): login is string => typeof login === 'string')
      : [],
    status: server.status === 'unknown' ? 'unknown' : 'online',
  };
}

class DevelopmentTeleportClient implements TeleportClient {
  private listeners = new Set<(event: TerminalEvent) => void>();
  private outputs = new Map<string, TerminalOutputSnapshot>();
  private sessions = new Map<string, { target: SessionTarget; input: string }>();

  async capabilities(): Promise<TeleportCapabilities> {
    return {
      nativeCoreLinked: false,
      passkey: true,
      totp: true,
      developmentDriver: true,
    };
  }

  async exportSession() {
    return JSON.stringify({
      version: 1,
      development: true,
      profile: developmentProfile(),
    });
  }

  async restoreSession(snapshotJson: string) {
    const snapshot = JSON.parse(snapshotJson);
    if (!snapshot?.development || !snapshot?.profile) {
      throw new Error('The saved development login is invalid.');
    }
    return snapshot.profile as AuthenticatedProfile;
  }

  async logout() {
    for (const sessionId of this.sessions.keys()) {
      const output = this.outputs.get(sessionId);
      if (output) {
        output.open = false;
        output.reason = 'Signed out';
      }
      this.emit({ type: 'closed', sessionId, reason: 'Signed out' });
    }
    this.sessions.clear();
    this.outputs.clear();
  }

  async beginLogin(request: LoginRequest): Promise<AuthChallenge> {
    await delay(420);
    if (!request.proxyAddress.trim() || !request.username.trim()) {
      throw new Error('Enter a cluster address and username.');
    }
    if (!request.password) {
      throw new Error('Enter your Teleport password.');
    }
    const challengeId = `challenge-${Date.now()}`;
    if (request.method === 'passkey') {
      return {
        kind: 'passkey',
        challengeId,
        browserUrl: `https://${request.proxyAddress.replace(/\/$/, '')}/web/mfa/browser/development-request`,
      };
    }
    return { kind: 'totp', challengeId, digits: 6 };
  }

  async finishTotp(challengeId: string, code: string) {
    await delay(360);
    if (!challengeId || !/^\d{6}$/.test(code)) {
      throw new Error('Enter the six-digit code from your authenticator.');
    }
    return developmentProfile();
  }

  async finishPasskey(challengeId: string) {
    await delay(520);
    if (!challengeId) {
      throw new Error('The passkey challenge expired. Start again.');
    }
    return developmentProfile();
  }

  async listServers(): Promise<TeleportServer[]> {
    await delay(300);
    return [
      {
        id: 'srv-atlas',
        hostname: 'atlas-build-01',
        address: '⟵ tunnel',
        labels: { env: 'dev', region: 'blr', role: 'builder' },
        logins: ['ubuntu', 'root'],
        status: 'online',
      },
      {
        id: 'srv-kepler',
        hostname: 'kepler-api-02',
        address: '⟵ tunnel',
        labels: { env: 'test', region: 'bom', role: 'api' },
        logins: ['ubuntu', 'deploy'],
        status: 'online',
      },
      {
        id: 'srv-cinder',
        hostname: 'cinder-db-01',
        address: '⟵ tunnel',
        labels: { env: 'lab', region: 'blr', role: 'database' },
        logins: ['postgres', 'ubuntu'],
        status: 'unknown',
      },
    ];
  }

  async openSession(target: SessionTarget): Promise<SessionHandle> {
    await delay(280);
    const session = { id: `session-${Date.now()}`, target };
    this.outputs.set(session.id, {
      sessionId: session.id,
      open: true,
      latestSequence: 0,
      truncated: false,
      chunks: [],
    });
    this.sessions.set(session.id, { target, input: '' });
    setTimeout(() => {
      this.emitData(
        session.id,
        `Connected through Teleport\r\n${target.login}@${target.hostname}:~$ `
      );
    }, 80);
    return session;
  }

  async writeSession(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session is not open.');
    const response = developmentTerminalResponse(session, data);
    setTimeout(() => {
      if (response.output) this.emitData(sessionId, response.output);
      if (response.close) this.finishSession(sessionId, 'Remote session closed');
    }, 90);
  }

  async resizeSession() {}

  async pingSession(sessionId: string) {
    if (!this.outputs.get(sessionId)?.open) {
      throw new Error('Session is not open.');
    }
  }

  async sessionOutput(sessionId: string, afterSequence: number) {
    const output = this.outputs.get(sessionId);
    if (!output) throw new Error('Terminal output is not available.');
    return {
      ...output,
      chunks: output.chunks.filter(chunk => chunk.sequence > afterSequence),
    };
  }

  async closeSession(sessionId: string) {
    this.finishSession(sessionId, 'Closed on device');
  }

  private finishSession(sessionId: string, reason: string) {
    this.sessions.delete(sessionId);
    const output = this.outputs.get(sessionId);
    if (output) {
      output.open = false;
      output.reason = reason;
    }
    this.emit({ type: 'closed', sessionId, reason });
  }

  subscribe(listener: (event: TerminalEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TerminalEvent) {
    this.listeners.forEach(listener => listener(event));
  }

  private emitData(sessionId: string, data: string) {
    const output = this.outputs.get(sessionId);
    if (!output?.open) return;
    const sequence = output.latestSequence + 1;
    output.latestSequence = sequence;
    output.chunks.push({ sequence, data });
    this.emit({ type: 'data', sessionId, data, sequence });
  }
}

function developmentProfile(): AuthenticatedProfile {
  return {
    proxyAddress: 'teleport.example.com:443',
    username: 'operator',
    clusterName: 'teleport.example.com',
    validUntil: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
  };
}

function developmentTerminalResponse(
  session: { target: SessionTarget; input: string },
  rawData: string
) {
  const data = rawData
    .replaceAll('\u001b[200~', '')
    .replaceAll('\u001b[201~', '')
    .replace(/\u001b(?:O.|\[[0-9;]*[A-Za-z~])/g, '');
  let output = '';
  let close = false;
  let previousWasCarriageReturn = false;

  for (const character of data) {
    if (character === '\n' && previousWasCarriageReturn) {
      previousWasCarriageReturn = false;
      continue;
    }
    previousWasCarriageReturn = character === '\r';
    if (character === '\r' || character === '\n') {
      const command = session.input.trim();
      if (command === 'exit' || command === 'logout') {
        output += '\r\nlogout\r\n';
        session.input = '';
        close = true;
        break;
      }
      const response = developmentCommand(command, session.target);
      output += '\r\n';
      if (response) output += `${response}\r\n`;
      output += '$ ';
      session.input = '';
      continue;
    }
    if (character === '\u0003') {
      session.input = '';
      output += '^C\r\n$ ';
      continue;
    }
    if (character === '\u007f' || character === '\b') {
      if (session.input) {
        session.input = Array.from(session.input).slice(0, -1).join('');
        output += '\b \b';
      }
      continue;
    }
    if (character === '\u001b') continue;
    session.input += character;
    output += character;
  }
  return { output, close };
}

function developmentCommand(command: string, target: SessionTarget) {
  switch (command) {
    case 'hostname':
      return target.hostname;
    case 'whoami':
      return target.login;
    case 'pwd':
      return `/home/${target.login}`;
    case 'clear':
      return '';
    default:
      return command ? `development driver: ${command}` : '';
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
