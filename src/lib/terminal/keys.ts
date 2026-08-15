export type TerminalModifiers = {
  ctrl: boolean;
  alt: boolean;
};

export type TerminalKey = {
  label: string;
  key: string;
  wide?: boolean;
};

export const TERMINAL_KEYS: TerminalKey[] = [
  { label: '^C', key: 'interrupt' },
  { label: 'ESC', key: 'escape' },
  { label: 'TAB', key: 'tab' },
  { label: '←', key: 'left' },
  { label: '↑', key: 'up' },
  { label: '↓', key: 'down' },
  { label: '→', key: 'right' },
  { label: 'HOME', key: 'home', wide: true },
  { label: 'END', key: 'end' },
  { label: 'PG↑', key: 'pageup' },
  { label: 'PG↓', key: 'pagedown' },
  { label: 'INS', key: 'insert' },
  { label: 'DEL', key: 'delete' },
  { label: 'BKSP', key: 'backspace', wide: true },
  ...Array.from({ length: 12 }, (_, index) => ({
    label: `F${index + 1}`,
    key: `f${index + 1}`,
  })),
];

const BASIC_SEQUENCES: Record<string, string> = {
  interrupt: '\u0003',
  escape: '\u001b',
  tab: '\t',
  backspace: '\u007f',
  insert: '\u001b[2~',
  delete: '\u001b[3~',
  pageup: '\u001b[5~',
  pagedown: '\u001b[6~',
  f5: '\u001b[15~',
  f6: '\u001b[17~',
  f7: '\u001b[18~',
  f8: '\u001b[19~',
  f9: '\u001b[20~',
  f10: '\u001b[21~',
  f11: '\u001b[23~',
  f12: '\u001b[24~',
};

const CSI_FINAL: Record<string, string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
  home: 'H',
  end: 'F',
  f1: 'P',
  f2: 'Q',
  f3: 'R',
  f4: 'S',
};

export function terminalKeySequence(key: string, modifiers: TerminalModifiers) {
  const modifier = 1 + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
  const final = CSI_FINAL[key];
  if (final) {
    if (modifier === 1) {
      return key.startsWith('f') ? `\u001bO${final}` : `\u001b[${final}`;
    }
    return `\u001b[1;${modifier}${final}`;
  }

  let sequence = BASIC_SEQUENCES[key] ?? '';
  if (!sequence) return sequence;
  if (modifier !== 1 && /\u001b\[\d+~/.test(sequence)) {
    sequence = sequence.replace('~', `;${modifier}~`);
    return sequence;
  }
  return modifiers.alt && key !== 'escape' ? `\u001b${sequence}` : sequence;
}

export function terminalTextSequence(text: string, modifiers: TerminalModifiers) {
  if (!text) return '';
  let sequence = text;
  if (modifiers.ctrl) {
    const first = text[0];
    const code = first.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) {
      sequence = String.fromCharCode(code & 0x1f) + text.slice(1);
    }
  }
  return modifiers.alt ? `\u001b${sequence}` : sequence;
}

export function terminalMouseTapSequence(column: number, row: number) {
  const x = Math.max(1, Math.floor(column));
  const y = Math.max(1, Math.floor(row));
  return `\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`;
}

export function terminalMouseEventSequence(
  column: number,
  row: number,
  action: 'press' | 'motion' | 'release'
) {
  const x = Math.max(1, Math.floor(column));
  const y = Math.max(1, Math.floor(row));
  if (action === 'release') return `\u001b[<0;${x};${y}m`;
  return `\u001b[<${action === 'motion' ? 32 : 0};${x};${y}M`;
}

export function terminalMouseScrollSequence(
  column: number,
  row: number,
  direction: 'up' | 'down',
  steps: number
) {
  const x = Math.max(1, Math.floor(column));
  const y = Math.max(1, Math.floor(row));
  const button = direction === 'up' ? 64 : 65;
  return `\u001b[<${button};${x};${y}M`.repeat(Math.max(1, Math.floor(steps)));
}
