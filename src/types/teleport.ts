export type AuthMethod = 'passkey' | 'totp';

export type AuthChallenge =
  | {
      kind: 'passkey';
      challengeId: string;
      browserUrl: string;
    }
  | {
      kind: 'totp';
      challengeId: string;
      digits: number;
    };

export type LoginRequest = {
  proxyAddress: string;
  username: string;
  password: string;
  method: AuthMethod;
  insecure: boolean;
};

export type AuthenticatedProfile = {
  proxyAddress: string;
  username: string;
  clusterName: string;
  validUntil: string;
};

export type SavedTeleportProfile = {
  id: string;
  name: string;
  profile: AuthenticatedProfile;
  sessionSnapshot: string | null;
  authMethod: AuthMethod;
  insecure: boolean;
  createdAt: string;
  lastUsedAt: string;
  signedOutAt?: string;
};

export type TeleportProfileStore = {
  version: 2;
  activeProfileId: string | null;
  profiles: SavedTeleportProfile[];
};

export type TeleportServer = {
  id: string;
  hostname: string;
  address: string;
  clusterName?: string;
  labels: Record<string, string>;
  logins: string[];
  status: 'online' | 'unknown';
};

export type SessionTarget = {
  serverId: string;
  hostname: string;
  login: string;
  columns: number;
  rows: number;
  tabId?: string;
  profileId?: string;
};

export type SessionHandle = {
  id: string;
  target: SessionTarget;
};

export type TeleportCapabilities = {
  nativeCoreLinked: boolean;
  passkey: boolean;
  totp: boolean;
  developmentDriver: boolean;
};

export type TerminalEvent =
  | {
      type: 'session';
      profileId: string;
      snapshot: string;
      profile: AuthenticatedProfile;
    }
  | {
      type: 'data';
      sessionId: string;
      data: string;
      sequence: number;
      alternateScreen?: boolean;
      mouseTracking?: boolean;
      bracketedPaste?: boolean;
      title?: string;
      bellCount?: number;
    }
  | { type: 'closed'; sessionId: string; reason?: string }
  | { type: 'error'; sessionId: string; message: string };

export type TerminalOutputSnapshot = {
  sessionId: string;
  open: boolean;
  latestSequence: number;
  truncated: boolean;
  chunks: { sequence: number; data: string }[];
  alternateScreen?: boolean;
  mouseTracking?: boolean;
  bracketedPaste?: boolean;
  title?: string;
  reason?: string;
  error?: string;
};
