export type ExpoTeleportModuleEvents = {
  onTerminalEvent: (event: TerminalEventPayload) => void;
};

export type TerminalEventPayload = {
  type: 'data' | 'closed' | 'error';
  sessionId: string;
  data?: string;
  sequence?: number;
  alternateScreen?: boolean;
  mouseTracking?: boolean;
  bracketedPaste?: boolean;
  reason?: string;
  message?: string;
};
