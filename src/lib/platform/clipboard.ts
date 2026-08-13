import ExpoTeleport from '../../../modules/expo-teleport';

export function readClipboardText() {
  return ExpoTeleport.getClipboardTextAsync();
}
