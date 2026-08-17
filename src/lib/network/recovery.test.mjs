import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyConnectionError,
  retryDelayMs,
} from './recovery.ts';

test('classifies confirmed Teleport rejection separately from transient failures', () => {
  const issue = classifyConnectionError(new Error('HTTP 401: access denied'));
  assert.equal(issue.kind, 'session-expired');
  assert.equal(issue.requiresAuthentication, true);
  assert.equal(issue.retryable, false);
  assert.equal(
    classifyConnectionError(new Error('HTTP 403: forbidden')).kind,
    'session-expired'
  );
});

test('classifies DNS, TLS, timeout, and proxy failures', () => {
  assert.equal(classifyConnectionError(new Error('lookup proxy: no such host')).kind, 'dns');
  assert.equal(classifyConnectionError(new Error('x509: certificate signed by unknown authority')).kind, 'tls');
  assert.equal(classifyConnectionError(new Error('context deadline exceeded')).kind, 'timeout');
  assert.equal(classifyConnectionError(new Error('connect: connection refused')).kind, 'proxy-unavailable');
});

test('network state takes precedence for an offline device', () => {
  const issue = classifyConnectionError(new Error('request failed'), { available: false });
  assert.equal(issue.kind, 'offline');
  assert.equal(issue.retryable, true);
});

test('retry delays use bounded exponential backoff', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(retryDelayMs),
    [800, 1600, 3200, 6400, 12000, 12000]
  );
});
