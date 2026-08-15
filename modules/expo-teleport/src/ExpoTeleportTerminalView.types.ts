import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export type TerminalDimensionsEvent = NativeSyntheticEvent<{
  columns: number;
  rows: number;
}>;

export type ExpoTeleportTerminalViewHandle = {
  scrollBy(rows: number): Promise<void>;
  scrollToBottom(): Promise<void>;
};

export type ExpoTeleportTerminalViewProps = ViewProps & {
  sessionId: string;
  fontSize: number;
  fallbackText?: string;
  onDimensions?: (event: TerminalDimensionsEvent) => void;
};
