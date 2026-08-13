import { NativeModule, requireNativeModule } from 'expo';

import { ExpoTeleportModuleEvents } from './ExpoTeleport.types';

declare class ExpoTeleportModule extends NativeModule<ExpoTeleportModuleEvents> {
  getCapabilitiesAsync(): Promise<string>;
  getClipboardTextAsync(): Promise<string>;
  exportSessionAsync(): Promise<string>;
  restoreSessionAsync(snapshotJson: string): Promise<string>;
  logoutAsync(): Promise<void>;
  beginLoginAsync(requestJson: string): Promise<string>;
  finishTotpAsync(challengeId: string, code: string): Promise<string>;
  finishPasskeyAsync(
    challengeId: string,
    credentialJson: string
  ): Promise<string>;
  listServersAsync(): Promise<string>;
  openSessionAsync(targetJson: string): Promise<string>;
  writeSessionAsync(sessionId: string, data: string): Promise<void>;
  resizeSessionAsync(
    sessionId: string,
    columns: number,
    rows: number
  ): Promise<void>;
  pingSessionAsync(sessionId: string): Promise<void>;
  sessionOutputAsync(
    sessionId: string,
    afterSequence: number
  ): Promise<string>;
  closeSessionAsync(sessionId: string): Promise<void>;
}

export default requireNativeModule<ExpoTeleportModule>('ExpoTeleport');
