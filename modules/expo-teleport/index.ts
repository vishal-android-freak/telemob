// Re-export the native module. On web, it will be resolved to ExpoTeleportModule.web.ts
// and on native platforms to ExpoTeleportModule.ts
export { default } from './src/ExpoTeleportModule';
export { default as ExpoTeleportTerminalView } from './src/ExpoTeleportTerminalView';
export type {
  ExpoTeleportTerminalViewHandle,
  ExpoTeleportTerminalViewProps,
  TerminalDimensionsEvent,
} from './src/ExpoTeleportTerminalView.types';
export * from './src/ExpoTeleport.types';
