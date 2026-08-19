import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTerminalTabCapacity,
  MAX_TERMINAL_TABS,
  TerminalTabLimitError,
} from './workspace-limit.ts';

test('allows terminal tabs below the workspace limit', () => {
  assert.doesNotThrow(() => assertTerminalTabCapacity(MAX_TERMINAL_TABS - 1));
});

test('rejects terminal tabs at and above the workspace limit', () => {
  for (const tabCount of [MAX_TERMINAL_TABS, MAX_TERMINAL_TABS + 1]) {
    assert.throws(
      () => assertTerminalTabCapacity(tabCount),
      error => error instanceof TerminalTabLimitError
        && error.message.includes(String(MAX_TERMINAL_TABS))
    );
  }
});
