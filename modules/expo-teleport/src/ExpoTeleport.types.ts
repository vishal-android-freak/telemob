export type ExpoTeleportModuleEvents = {
  onTerminalEvent: (event: TerminalEventPayload) => void;
};

export type TerminalEventPayload = {
  type: 'data' | 'closed' | 'error' | 'session' | 'forward';
  sessionId?: string;
  profileId?: string;
  snapshot?: string;
  profile?: {
    proxyAddress: string;
    username: string;
    clusterName: string;
    validUntil: string;
  };
  data?: string;
  sequence?: number;
  alternateScreen?: boolean;
  mouseTracking?: boolean;
  bracketedPaste?: boolean;
  title?: string;
  bellCount?: number;
  reason?: string;
  message?: string;
  forward?: {
    id: string;
    state: 'connecting' | 'listening' | 'stopped' | 'error';
    [key: string]: unknown;
  };
};
