import {
  getConnectivitySnapshot,
  waitForConnectivityChange,
} from '@/lib/network/connectivity';
import {
  classifyConnectionError,
  ConnectionRecoveryError,
  offlineIssue,
  retryDelayMs,
  type ConnectionIssue,
} from '@/lib/network/recovery';

export type ConnectionRetryProgress = {
  issue: ConnectionIssue;
  failedAttempt: number;
  nextAttempt: number;
  delayMs: number | null;
};

export async function runWithConnectionRetry<Result>(
  operation: (attempt: number) => Promise<Result>,
  {
    maxAttempts = 4,
    onRetry,
    signal,
  }: {
    maxAttempts?: number;
    onRetry?: (progress: ConnectionRetryProgress) => void;
    signal?: AbortSignal;
  } = {}
) {
  let attempt = 1;
  while (attempt <= maxAttempts) {
    throwIfAborted(signal);
    let connectivity = getConnectivitySnapshot();
    if (!connectivity.available) {
      onRetry?.({
        issue: offlineIssue(),
        failedAttempt: attempt - 1,
        nextAttempt: attempt,
        delayMs: null,
      });
      connectivity = await waitForConnectivityChange({
        afterGeneration: connectivity.generation,
        requireAvailable: true,
        signal,
      });
    }

    try {
      return await operation(attempt);
    } catch (error) {
      throwIfAborted(signal);
      connectivity = getConnectivitySnapshot();
      const issue = classifyConnectionError(error, connectivity);
      if (!issue.retryable || attempt >= maxAttempts) {
        throw new ConnectionRecoveryError(issue, error);
      }
      const delayMs = connectivity.available ? retryDelayMs(attempt) : null;
      onRetry?.({
        issue: connectivity.available ? issue : offlineIssue(),
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        delayMs,
      });
      await waitForConnectivityChange({
        afterGeneration: connectivity.generation,
        requireAvailable: !connectivity.available,
        signal,
        timeoutMs: delayMs ?? undefined,
      });
      attempt += 1;
    }
  }
  throw new Error('Connection retry loop ended unexpectedly.');
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error('Connection recovery was cancelled.');
  error.name = 'AbortError';
  throw error;
}
