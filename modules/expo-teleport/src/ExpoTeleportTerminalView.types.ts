import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export type TerminalDimensionsEvent = NativeSyntheticEvent<{
  columns: number;
  rows: number;
}>;

export type ExpoTeleportTerminalViewHandle = {
  scrollBy(rows: number): Promise<void>;
  scrollToBottom(): Promise<void>;
  selectRange(
    startColumn: number,
    startRow: number,
    endColumn: number,
    endRow: number
  ): Promise<boolean>;
  clearSelection(): Promise<void>;
  copySelection(): Promise<boolean>;
  findText(query: string, backwards: boolean): Promise<boolean>;
  hyperlinkAt(column: number, row: number): Promise<string | null>;
};

export type ExpoTeleportTerminalViewProps = ViewProps & {
  sessionId: string;
  fontSize: number;
  fallbackText?: string;
  onDimensions?: (event: TerminalDimensionsEvent) => void;
};
