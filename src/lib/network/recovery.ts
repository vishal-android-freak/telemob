export type ConnectionIssueKind =
  | 'offline'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'proxy-unavailable'
  | 'authorization'
  | 'verification-required'
  | 'session-expired'
  | 'configuration'
  | 'unknown';

export type ConnectionIssue = {
  kind: ConnectionIssueKind;
  title: string;
  message: string;
  retryable: boolean;
  requiresAuthentication: boolean;
};

const rejectedSessionPattern = /\bHTTP (?:401|403)\b|Teleport login has expired|saved (?:Teleport|development) login (?:has expired|is incomplete)|decode saved Teleport login/i;

export class ConnectionRecoveryError extends Error {
  readonly issue: ConnectionIssue;
  readonly originalError: unknown;

  constructor(issue: ConnectionIssue, originalError: unknown) {
    super(issue.message);
    this.name = 'ConnectionRecoveryError';
    this.issue = issue;
    this.originalError = originalError;
  }
}

export function classifyConnectionError(
  error: unknown,
  connectivity: { available: boolean } = { available: true }
): ConnectionIssue {
  if (error instanceof ConnectionRecoveryError) return error.issue;
  const raw = rawErrorMessage(error);

  if (rejectedSessionPattern.test(raw)) {
    return {
      kind: 'session-expired',
      title: 'Sign-in required',
      message: 'Teleport rejected the saved login. Sign in again to continue.',
      retryable: false,
      requiresAuthentication: true,
    };
  }
  if (/additional verification|required session mfa|per-session passkey|per-session mfa/i.test(raw)) {
    return {
      kind: 'verification-required',
      title: 'Additional verification required',
      message: 'This connection requires additional verification that Telemob does not support yet.',
      retryable: false,
      requiresAuthentication: false,
    };
  }
  if (/permission denied|not authorized|authorization denied|access denied|forbidden/i.test(raw)) {
    return {
      kind: 'authorization',
      title: 'Access denied',
      message: 'Teleport denied access to this resource. Your saved login has been kept.',
      retryable: false,
      requiresAuthentication: false,
    };
  }
  if (!connectivity.available || /network is offline|not connected to the internet/i.test(raw)) {
    return offlineIssue();
  }
  if (/no such host|temporary failure in name resolution|name or service not known|nodename nor servname|could not resolve|lookup .*(?:no such host|server misbehaving)/i.test(raw)) {
    return {
      kind: 'dns',
      title: 'Proxy name not found',
      message: 'The Teleport proxy name could not be resolved. Check private DNS or VPN connectivity.',
      retryable: true,
      requiresAuthentication: false,
    };
  }
  if (/x509|certificate|unknown authority|hostname mismatch|tls handshake|remote error: tls|ssl/i.test(raw)) {
    return {
      kind: 'tls',
      title: 'Secure connection failed',
      message: 'The Teleport proxy certificate could not be verified. Check the hostname and trusted CA settings.',
      retryable: false,
      requiresAuthentication: false,
    };
  }
  if (/timed? out|timeout|deadline exceeded|terminal did not answer a liveness check/i.test(raw)) {
    return {
      kind: 'timeout',
      title: 'Connection timed out',
      message: 'The Teleport proxy did not respond in time. Telemob will retry automatically.',
      retryable: true,
      requiresAuthentication: false,
    };
  }
  if (/connection refused|connection reset|broken pipe|network is unreachable|no route to host|unexpected eof|\bEOF\b|HTTP 50[234]|service unavailable|bad gateway|proxy temporarily unavailable|terminal connection ended|use of closed network connection/i.test(raw)) {
    return {
      kind: 'proxy-unavailable',
      title: 'Proxy unavailable',
      message: 'The Teleport proxy is temporarily unreachable. Telemob will retry automatically.',
      retryable: true,
      requiresAuthentication: false,
    };
  }
  if (/unsupported|must be positive|is required|is missing|invalid session target|decode .*request|terminal protocol error/i.test(raw)) {
    return {
      kind: 'configuration',
      title: 'Connection could not start',
      message: 'The connection request is incomplete or unsupported.',
      retryable: false,
      requiresAuthentication: false,
    };
  }
  return {
    kind: 'unknown',
    title: 'Connection interrupted',
    message: 'The connection was interrupted. Telemob will retry automatically.',
    retryable: true,
    requiresAuthentication: false,
  };
}

export function isRejectedSession(error: unknown) {
  return classifyConnectionError(error).requiresAuthentication;
}

export function retryDelayMs(failedAttempt: number) {
  return Math.min(12_000, 800 * (2 ** Math.max(0, failedAttempt - 1)));
}

export function rawErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'The connection could not continue.';
}

export function offlineIssue(): ConnectionIssue {
  return {
    kind: 'offline',
    title: 'Waiting for a network',
    message: 'The device is offline. Telemob will continue automatically when a connection returns.',
    retryable: true,
    requiresAuthentication: false,
  };
}
