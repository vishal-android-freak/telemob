import type { Terminal as HeadlessTerminal } from '@xterm/headless';

type RuntimeNavigator = Navigator & {
  platform?: string;
  userAgent?: string;
};

export function createTerminal(columns: number, rows: number): HeadlessTerminal {
  ensureNavigatorMetadata();
  // Loading must happen after the compatibility metadata is present because
  // xterm inspects the host runtime while its module is initialized.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Terminal } = require(
    '@xterm/headless/lib-headless/xterm-headless.js'
  ) as typeof import('@xterm/headless');
  return new Terminal({
    allowProposedApi: true,
    cols: columns,
    rows,
    scrollback: 2_000,
  });
}

function ensureNavigatorMetadata() {
  const runtime = globalThis as typeof globalThis & { navigator?: RuntimeNavigator };
  if (!runtime.navigator) {
    Object.defineProperty(runtime, 'navigator', {
      configurable: true,
      value: {},
    });
  }

  defineWhenMissing(runtime.navigator!, 'userAgent', 'React Native');
  defineWhenMissing(runtime.navigator!, 'platform', 'React Native');
}

function defineWhenMissing(
  navigator: RuntimeNavigator,
  property: 'platform' | 'userAgent',
  value: string
) {
  if (typeof navigator[property] === 'string') return;
  Object.defineProperty(navigator, property, {
    configurable: true,
    value,
  });
}
