export type ExpoTeleportModuleEvents = {
  onTerminalEvent: (event: TerminalEventPayload) => void;
};

export type TerminalEventPayload = {
  type: 'data' | 'closed' | 'error' | 'session';
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
};
