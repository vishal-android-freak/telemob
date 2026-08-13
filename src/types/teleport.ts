export type AuthMethod = 'passkey' | 'totp';

export type AuthChallenge =
  | {
      kind: 'passkey';
      challengeId: string;
      rpId: string;
      challenge: string;
      allowedCredentialIds: string[];
      requestJson: string;
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

export type TeleportServer = {
  id: string;
  hostname: string;
  address: string;
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
  | { type: 'data'; sessionId: string; data: string; sequence: number }
  | { type: 'closed'; sessionId: string; reason?: string }
  | { type: 'error'; sessionId: string; message: string };

export type TerminalOutputSnapshot = {
  sessionId: string;
  open: boolean;
  latestSequence: number;
  truncated: boolean;
  chunks: { sequence: number; data: string }[];
  reason?: string;
  error?: string;
};
