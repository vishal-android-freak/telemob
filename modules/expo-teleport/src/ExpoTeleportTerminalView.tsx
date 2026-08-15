import { forwardRef, useImperativeHandle } from 'react';
import { Text, View } from 'react-native';

import type {
  ExpoTeleportTerminalViewHandle,
  ExpoTeleportTerminalViewProps,
} from './ExpoTeleportTerminalView.types';

export default forwardRef<ExpoTeleportTerminalViewHandle, ExpoTeleportTerminalViewProps>(
function ExpoTeleportTerminalView(props, ref) {
  useImperativeHandle(ref, () => ({
    scrollBy: async () => undefined,
    scrollToBottom: async () => undefined,
  }), []);
  return (
    <View style={[props.style, { backgroundColor: '#0B1117', overflow: 'hidden' }]}>
      <Text
        style={{
          color: '#DDE6EA',
          fontFamily: 'monospace',
          fontSize: props.fontSize,
        }}
      >
        {props.fallbackText}
      </Text>
    </View>
  );
});
