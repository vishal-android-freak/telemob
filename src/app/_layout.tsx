import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
  useFonts as useMonoFonts,
} from '@expo-google-fonts/ibm-plex-mono';
import {
  Newsreader_400Regular,
  Newsreader_500Medium,
  Newsreader_600SemiBold,
  useFonts as useNewsreaderFonts,
} from '@expo-google-fonts/newsreader';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { palette } from '@/constants/tokens';
import { useTeleportSessionKeepAlive } from '@/lib/teleport/use-session-keepalive';

const relayTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: palette.ink,
    card: palette.ink,
    primary: palette.copper,
    text: palette.porcelain,
    border: palette.rule,
    notification: palette.signal,
  },
};

export default function RootLayout() {
  useTeleportSessionKeepAlive();
  const [monoLoaded] = useMonoFonts({
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });
  const [newsreaderLoaded] = useNewsreaderFonts({
    Newsreader_400Regular,
    Newsreader_500Medium,
    Newsreader_600SemiBold,
  });

  if (!monoLoaded || !newsreaderLoaded) {
    return null;
  }

  return (
    <KeyboardProvider>
      <ThemeProvider value={relayTheme}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: palette.ink },
            animation: 'slide_from_right',
          }}
        />
      </ThemeProvider>
    </KeyboardProvider>
  );
}
