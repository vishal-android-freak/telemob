import type { Terminal } from '@xterm/headless';

import { palette } from '@/constants/tokens';

export type TerminalCellStyle = {
  backgroundColor?: string;
  color: string;
  cursor: boolean;
  dim: boolean;
  italic: boolean;
  bold: boolean;
  decoration: 'none' | 'underline' | 'line-through' | 'underline line-through';
};

export type TerminalRun = TerminalCellStyle & {
  cells: number;
  column: number;
  text: string;
};

export type TerminalLine = {
  runs: TerminalRun[];
};

const ANSI_COLORS = [
  '#000000', '#CD3131', '#0DBC79', '#E5E510',
  '#2472C8', '#BC3FBC', '#11A8CD', '#E5E5E5',
  '#666666', '#F14C4C', '#23D18B', '#F5F543',
  '#3B8EEA', '#D670D6', '#29B8DB', '#FFFFFF',
];

export function snapshotTerminal(terminal: Terminal): TerminalLine[] {
  const buffer = terminal.buffer.active;
  const isAlternate = buffer.type === 'alternate';
  const firstLine = isAlternate ? buffer.baseY : 0;
  const finalLine = isAlternate
    ? Math.min(buffer.length - 1, buffer.baseY + terminal.rows - 1)
    : Math.min(buffer.length - 1, buffer.baseY + buffer.cursorY);
  const nullCell = buffer.getNullCell();
  const lines: TerminalLine[] = [];

  for (let y = firstLine; y <= finalLine; y += 1) {
    const line = buffer.getLine(y);
    const runs: TerminalRun[] = [];

    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line?.getCell(x, nullCell);
      if (!cell || cell.getWidth() === 0) continue;

      const isCursor = y === buffer.baseY + buffer.cursorY && x === buffer.cursorX;
      const foreground = colorFor(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), palette.porcelain);
      const background = colorFor(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), palette.terminal);
      const color = cell.isInverse() ? background : foreground;
      const backgroundColor = isCursor
        ? palette.copper
        : cell.isInverse() || !cell.isBgDefault()
          ? (cell.isInverse() ? foreground : background)
          : undefined;
      const hiddenColor = backgroundColor ?? palette.terminal;
      const decoration = decorationFor(Boolean(cell.isUnderline()), Boolean(cell.isStrikethrough()));
      const style: TerminalCellStyle = {
        color: isCursor ? palette.ink : cell.isInvisible() ? hiddenColor : color,
        backgroundColor,
        cursor: isCursor,
        dim: Boolean(cell.isDim()),
        italic: Boolean(cell.isItalic()),
        bold: Boolean(cell.isBold()),
        decoration,
      };
      const text = cell.getChars() || ' ';
      const previous = runs.at(-1);

      if (previous && sameStyle(previous, style)) {
        previous.text += text;
        previous.cells += cell.getWidth();
      } else {
        runs.push({ ...style, cells: cell.getWidth(), column: x, text });
      }
    }

    lines.push({ runs });
  }

  return lines.length ? lines : [{ runs: [defaultRun(' ')] }];
}

function colorFor(isRgb: boolean, isPalette: boolean, value: number, fallback: string) {
  if (isRgb) return `#${value.toString(16).padStart(6, '0')}`;
  if (isPalette) return ansiColor(value);
  return fallback;
}

function ansiColor(index: number) {
  if (index < ANSI_COLORS.length) return ANSI_COLORS[index];
  if (index >= 232) {
    const channel = 8 + (index - 232) * 10;
    return rgb(channel, channel, channel);
  }

  const offset = index - 16;
  const red = Math.floor(offset / 36);
  const green = Math.floor((offset % 36) / 6);
  const blue = offset % 6;
  const channel = (value: number) => value === 0 ? 0 : 55 + value * 40;
  return rgb(channel(red), channel(green), channel(blue));
}

function rgb(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function decorationFor(underline: boolean, strikethrough: boolean): TerminalCellStyle['decoration'] {
  if (underline && strikethrough) return 'underline line-through';
  if (underline) return 'underline';
  if (strikethrough) return 'line-through';
  return 'none';
}

function sameStyle(left: TerminalCellStyle, right: TerminalCellStyle) {
  return left.color === right.color
    && left.backgroundColor === right.backgroundColor
    && left.cursor === right.cursor
    && left.dim === right.dim
    && left.italic === right.italic
    && left.bold === right.bold
    && left.decoration === right.decoration;
}

function defaultRun(text: string): TerminalRun {
  return {
    cells: 1,
    column: 0,
    text,
    color: palette.porcelain,
    cursor: false,
    dim: false,
    italic: false,
    bold: false,
    decoration: 'none',
  };
}
