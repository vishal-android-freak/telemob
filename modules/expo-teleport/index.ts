// Re-export the native module. On web, it will be resolved to ExpoTeleportModule.web.ts
// and on native platforms to ExpoTeleportModule.ts
export { default } from './src/ExpoTeleportModule';
export * from './src/ExpoTeleport.types';
