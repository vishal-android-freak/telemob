import { NativeModule, registerWebModule } from 'expo';

import { ExpoTeleportModuleEvents } from './ExpoTeleport.types';

class ExpoTeleportModule extends NativeModule<ExpoTeleportModuleEvents> {
  async getClipboardTextAsync() {
    return navigator.clipboard?.readText() ?? '';
  }

  async getCapabilitiesAsync() {
    return JSON.stringify({
      nativeCoreLinked: false,
      passkey: false,
      totp: false,
      localPortForwarding: false,
      developmentDriver: true,
    });
  }
}

export default registerWebModule(ExpoTeleportModule, 'ExpoTeleportModule');
