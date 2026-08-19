export const MAX_TERMINAL_TABS = 10;

export class TerminalTabLimitError extends Error {
  constructor() {
    super(
      `You can open up to ${MAX_TERMINAL_TABS} terminal tabs. Disconnect a tab before opening another.`
    );
    this.name = 'TerminalTabLimitError';
  }
}

export function assertTerminalTabCapacity(currentTabCount: number) {
  if (currentTabCount >= MAX_TERMINAL_TABS) {
    throw new TerminalTabLimitError();
  }
}
