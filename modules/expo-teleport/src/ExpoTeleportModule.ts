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
  beginForwardAuthorizationAsync(requestJson: string): Promise<string>;
  finishForwardTotpAsync(challengeId: string, code: string): Promise<string>;
  finishForwardPasskeyAsync(challengeId: string, credentialJson: string): Promise<string>;
  forwardAuthorizationStatusAsync(): Promise<string>;
  startLocalForwardAsync(requestJson: string): Promise<string>;
  listLocalForwardsAsync(): Promise<string>;
  stopLocalForwardAsync(id: string): Promise<void>;
  stopAllLocalForwardsAsync(): Promise<void>;
  openSessionAsync(targetJson: string): Promise<string>;
  writeSessionAsync(sessionId: string, data: string): Promise<void>;
  sendTerminalKeyAsync(
    sessionId: string,
    key: string,
    text: string,
    ctrl: boolean,
    alt: boolean,
    shift: boolean,
    action: string
  ): Promise<void>;
  sendTerminalMouseTapAsync(sessionId: string, column: number, row: number): Promise<boolean>;
  sendTerminalMouseEventAsync(
    sessionId: string,
    column: number,
    row: number,
    action: string
  ): Promise<boolean>;
  sendTerminalMouseScrollAsync(
    sessionId: string,
    column: number,
    row: number,
    direction: string,
    steps: number
  ): Promise<boolean>;
  sendTerminalFocusAsync(sessionId: string, focused: boolean): Promise<void>;
  pasteSessionAsync(sessionId: string, data: string): Promise<void>;
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
