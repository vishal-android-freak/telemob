import type { ComponentType, RefAttributes } from 'react';
import { requireNativeViewManager } from 'expo-modules-core';

import type {
  ExpoTeleportTerminalViewHandle,
  ExpoTeleportTerminalViewProps,
} from './ExpoTeleportTerminalView.types';

export default requireNativeViewManager<ExpoTeleportTerminalViewProps>('ExpoTeleport') as ComponentType<
  ExpoTeleportTerminalViewProps & RefAttributes<ExpoTeleportTerminalViewHandle>
>;
