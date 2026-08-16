import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  type GestureResponderEvent,
  Keyboard,
  LayoutChangeEvent,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  ExpoTeleportTerminalView,
  type ExpoTeleportTerminalViewHandle,
  type TerminalDimensionsEvent,
} from '../../../modules/expo-teleport';
import { palette, space, type } from '@/constants/tokens';
import { getResponsiveLayout } from '@/lib/layout/responsive';
import { readClipboardText } from '@/lib/platform/clipboard';
import {
  TERMINAL_KEYS,
  type TerminalModifiers,
} from '@/lib/terminal/keys';
import { getTerminalSessionManager } from '@/lib/terminal/session-manager';

const SHELL_TERMINAL_FONT_SIZE = 7.5;
const FULL_SCREEN_TERMINAL_FONT_SIZE = 11;
const TERMINAL_CELL_WIDTH_RATIO = 0.6;
const TERMINAL_LINE_HEIGHT_RATIO = 20 / 13;
const INITIAL_FONT_METRICS = {
  fontSize: SHELL_TERMINAL_FONT_SIZE,
  lineHeight: SHELL_TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT_RATIO,
};
const TERMINAL_TAP_SLOP = 8;
const TERMINAL_SELECTION_HOLD_MS = 450;

export default function TerminalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId: string;
    hostname: string;
    login: string;
  }>();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const layout = getResponsiveLayout(windowWidth, windowHeight);
  const [largeTerminal] = useState(layout.tablet);
  const [manager] = useState(getTerminalSessionManager);
  const [session, setSession] = useState(manager.getSnapshot);
  const [dimensions, setDimensions] = useState({ columns: 0, rows: 0 });
  const [viewportReady, setViewportReady] = useState(false);
  const [fontMetrics, setFontMetrics] = useState(INITIAL_FONT_METRICS);
  const [command, setCommand] = useState('');
  const [lineMode, setLineMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const [modifiers, setModifiers] = useState<TerminalModifiers>({ ctrl: false, alt: false });
  const modifiersRef = useRef<TerminalModifiers>({ ctrl: false, alt: false });
  const dimensionsRef = useRef<{ columns: number; rows: number } | null>(null);
  const nativeTerminalRef = useRef<ExpoTeleportTerminalViewHandle>(null);
  const directInputRef = useRef<TextInput>(null);
  const directInputValueRef = useRef('');
  const directInputFocusedRef = useRef(false);
  const keyboardVisibleRef = useRef(Keyboard.isVisible());
  const lineInputRef = useRef<TextInput>(null);
  const searchInputRef = useRef<TextInput>(null);
  const terminalViewportRef = useRef<View>(null);
  const viewportSizeRef = useRef<{ width: number; height: number } | null>(null);
  const sawActiveSessionRef = useRef(false);
  const leftTerminalRef = useRef(false);
  const terminalTouchRef = useRef({
    pageX: 0,
    pageY: 0,
    lastPageX: 0,
    lastPageY: 0,
    handled: false,
    moved: false,
  });
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionActiveRef = useRef(false);
  const selectionAnchorRef = useRef<{ column: number; row: number } | null>(null);
  const selectionEndRef = useRef<{ column: number; row: number } | null>(null);
  const remoteDragActiveRef = useRef(false);
  const remoteDragGestureRef = useRef(0);
  const remoteMouseLastCellRef = useRef<{ column: number; row: number } | null>(null);
  const remoteMouseWriteRef = useRef<Promise<void>>(Promise.resolve());
  const connected = session.state === 'connected';

  useEffect(() => {
    const unsubscribe = manager.subscribe(setSession);
    const size = dimensionsRef.current;
    if (!viewportReady || !size) return unsubscribe;
    manager.attach({
      serverId: params.serverId,
      hostname: params.hostname,
      login: params.login,
      ...size,
    }, size);
    return () => {
      unsubscribe();
      manager.detach();
    };
  }, [manager, params.hostname, params.login, params.serverId, viewportReady]);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisibleRef.current = true;
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisibleRef.current = false;
      // Android Back hides the IME without reliably blurring the focused
      // TextInput. Explicitly release it so the next terminal tap can focus it
      // and open the keyboard in one attempt.
      directInputRef.current?.blur();
      lineInputRef.current?.blur();
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  useEffect(() => () => {
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
  }, []);

  useEffect(() => {
    if (isActiveTerminalState(session.state)) {
      sawActiveSessionRef.current = true;
      return;
    }
    if (
      session.state !== 'closed'
      || !sawActiveSessionRef.current
      || leftTerminalRef.current
    ) {
      return;
    }
    leftTerminalRef.current = true;
    router.back();
  }, [router, session.state]);

  const applyTerminalSize = useCallback((width: number, height: number, narrowTUI: boolean) => {
    const fontSize = narrowTUI
      ? FULL_SCREEN_TERMINAL_FONT_SIZE + (largeTerminal ? 1 : 0)
      : SHELL_TERMINAL_FONT_SIZE + (largeTerminal ? 1 : 0);
    const lineHeight = fontSize * TERMINAL_LINE_HEIGHT_RATIO;
    setFontMetrics(current =>
      Math.abs(current.fontSize - fontSize) < 0.01
        && Math.abs(current.lineHeight - lineHeight) < 0.01
        ? current
        : { fontSize, lineHeight }
    );

    // The native renderer measures the actual platform monospace font and is
    // the sole source of PTY dimensions. A second JavaScript estimate races
    // that measurement during keyboard animation and makes TUIs redraw at
    // multiple conflicting sizes. Web has no native measurement callback, so
    // retain the estimate only for its text fallback.
    if (Platform.OS !== 'web') return;
    const availableWidth = Math.max(1, width);
    const availableHeight = Math.max(1, height);
    const cellWidth = fontSize * TERMINAL_CELL_WIDTH_RATIO;
    const next = {
      columns: Math.max(1, Math.floor(availableWidth / cellWidth)),
      rows: Math.max(8, Math.floor(availableHeight / lineHeight)),
    };
    const current = dimensionsRef.current;
    if (current && next.columns === current.columns && next.rows === current.rows) return;

    dimensionsRef.current = next;
    setDimensions(next);
    if (!current) setViewportReady(true);
    manager.resize(next.columns, next.rows);
  }, [largeTerminal, manager]);

  function resizeTerminal(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    if (width < 1 || height < 1) return;
    viewportSizeRef.current = { width, height };
    applyTerminalSize(width, height, session.alternateScreen);
  }

  useEffect(() => {
    const viewport = viewportSizeRef.current;
    if (!viewport) return;
    applyTerminalSize(viewport.width, viewport.height, session.alternateScreen);
  }, [applyTerminalSize, session.alternateScreen]);

  function applyNativeDimensions(event: TerminalDimensionsEvent) {
    const next = event.nativeEvent;
    const current = dimensionsRef.current;
    if (current && next.columns === current.columns && next.rows === current.rows) return;
    dimensionsRef.current = next;
    setDimensions(next);
    if (!current) setViewportReady(true);
    manager.resize(next.columns, next.rows);
  }

  async function submitCommand() {
    if (!connected || !command) return;
    const value = command;
    setCommand('');
    await manager.sendKey('text', value).catch(() => undefined);
    await manager.sendKey('enter').catch(() => undefined);
  }

  async function sendTerminalKey(key: string) {
    const activeModifiers = modifiersRef.current;
    if (searchOpen && (key === 'up' || key === 'down')) {
      releaseModifiers();
      await findTerminalText(key === 'up');
      return;
    }
    releaseModifiers();
    if (!connected) return;
    try {
      await manager.sendKey(key, '', activeModifiers, 'press');
      await manager.sendKey(key, '', activeModifiers, 'release');
    } catch {
      // The session manager surfaces terminal write failures in its snapshot.
    }
  }

  function sendTypedText(nextText: string) {
    const previousText = directInputValueRef.current;
    directInputValueRef.current = nextText;
    if (!nextText) return;

    const insertedText = nextText.startsWith(previousText)
      ? nextText.slice(previousText.length)
      : nextText.slice(Math.min(previousText.length, nextText.length));
    if (insertedText) {
      void manager.sendKey('text', insertedText, modifiersRef.current).catch(() => undefined);
    }
    releaseModifiers();

    // A retained TextInput lets Android IMEs rewrite their entire composing
    // buffer. Treating that rewritten value as newly inserted text duplicates
    // an already-sent command. Drain the native field after every edit so it
    // never becomes a second terminal buffer. Keep the ref until the native
    // empty-value event arrives, which still makes back-to-back edits yield a
    // suffix if clear() has not reached the UI thread yet.
    directInputRef.current?.clear();
  }

  function releaseModifiers() {
    if (modifiersRef.current.ctrl || modifiersRef.current.alt) {
      modifiersRef.current = { ctrl: false, alt: false };
      setModifiers(modifiersRef.current);
    }
  }

  function toggleModifier(modifier: keyof TerminalModifiers) {
    modifiersRef.current = {
      ...modifiersRef.current,
      [modifier]: !modifiersRef.current[modifier],
    };
    setModifiers(modifiersRef.current);
  }

  function resetDirectInput() {
    directInputValueRef.current = '';
    directInputRef.current?.clear();
  }

  function startTerminalTouch(event: GestureResponderEvent) {
    const { pageX, pageY } = event.nativeEvent;
    const gesture = ++remoteDragGestureRef.current;
    terminalTouchRef.current = {
      pageX,
      pageY,
      lastPageX: pageX,
      lastPageY: pageY,
      handled: false,
      moved: false,
    };
    selectionActiveRef.current = false;
    remoteDragActiveRef.current = false;
    remoteMouseLastCellRef.current = null;
    selectionAnchorRef.current = null;
    selectionEndRef.current = null;
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = setTimeout(() => {
      selectionTimerRef.current = null;
      if (terminalTouchRef.current.moved || !connected) return;
      if (session.mouseTracking) {
        remoteDragActiveRef.current = true;
        dismissTerminalKeyboard();
        sendRemoteMouseEvent('press', pageX, pageY, gesture);
        return;
      }
      selectionActiveRef.current = true;
      dismissTerminalKeyboard();
      updateTerminalSelection(pageX, pageY, true);
    }, TERMINAL_SELECTION_HOLD_MS);
  }

  function moveTerminalTouch(event: GestureResponderEvent) {
    const touch = terminalTouchRef.current;
    const { pageX, pageY } = event.nativeEvent;
    touch.lastPageX = pageX;
    touch.lastPageY = pageY;
    if (
      Math.abs(pageX - touch.pageX) > TERMINAL_TAP_SLOP
      || Math.abs(pageY - touch.pageY) > TERMINAL_TAP_SLOP
    ) {
      touch.moved = true;
      if (!selectionActiveRef.current && selectionTimerRef.current) {
        clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = null;
      }
    }
    if (remoteDragActiveRef.current) {
      sendRemoteMouseEvent('motion', pageX, pageY, remoteDragGestureRef.current);
      return;
    }
    if (selectionActiveRef.current) updateTerminalSelection(pageX, pageY, false);
  }

  function finishTerminalTouch() {
    const touch = terminalTouchRef.current;
    if (touch.handled) return;
    touch.handled = true;
    if (selectionTimerRef.current) {
      clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = null;
    }
    if (remoteDragActiveRef.current) {
      sendRemoteMouseEvent(
        'release',
        touch.lastPageX,
        touch.lastPageY,
        remoteDragGestureRef.current
      );
      remoteDragActiveRef.current = false;
      touch.moved = false;
      return;
    }
    if (selectionActiveRef.current) {
      updateTerminalSelection(touch.lastPageX, touch.lastPageY, false);
      selectionActiveRef.current = false;
      touch.moved = false;
      return;
    }
    if (touch.moved && connected) {
      void nativeTerminalRef.current?.clearSelection();
      sendTerminalScroll(touch);
    } else if (connected) {
      void nativeTerminalRef.current?.clearSelection();
      sendTerminalTap(touch.pageX, touch.pageY);
    }
    touch.moved = false;
  }

  function updateTerminalSelection(pageX: number, pageY: number, begin: boolean) {
    terminalViewportRef.current?.measureInWindow((viewportX, viewportY, width, height) => {
      if (
        dimensions.columns < 1
        || dimensions.rows < 1
        || width < 1
        || height < 1
      ) {
        return;
      }
      const column = Math.min(
        dimensions.columns,
        Math.max(1, Math.floor((pageX - viewportX) * dimensions.columns / width) + 1)
      );
      const row = Math.min(
        dimensions.rows,
        Math.max(1, Math.floor((pageY - viewportY) * dimensions.rows / height) + 1)
      );
      if (begin || !selectionAnchorRef.current) {
        selectionAnchorRef.current = { column, row };
      }
      const anchor = selectionAnchorRef.current;
      const previous = selectionEndRef.current;
      if (previous?.column === column && previous.row === row) return;
      selectionEndRef.current = { column, row };
      void nativeTerminalRef.current?.selectRange(
        anchor.column,
        anchor.row,
        column,
        row
      );
    });
  }

  function sendTerminalScroll(touch: typeof terminalTouchRef.current) {
    terminalViewportRef.current?.measureInWindow((viewportX, viewportY, width, height) => {
      const x = touch.lastPageX - viewportX;
      const y = touch.lastPageY - viewportY;
      if (
        x < 0 || y < 0 || width < 1 || height < 1
        || dimensions.columns < 1 || dimensions.rows < 1
      ) return;

      const rowHeight = height / dimensions.rows;
      const column = Math.floor(x * dimensions.columns / width) + 1;
      const row = Math.floor(y * dimensions.rows / height) + 1;
      if (column > dimensions.columns || row > dimensions.rows) return;

      const deltaY = touch.lastPageY - touch.pageY;
      const steps = Math.min(8, Math.max(1, Math.round(Math.abs(deltaY) / rowHeight)));
      const direction = deltaY > 0 ? 'up' : 'down';
      void manager.sendMouseScroll(column, row, direction, steps)
        .then(sent => {
          if (!sent) {
            void nativeTerminalRef.current?.scrollBy(deltaY > 0 ? -steps : steps);
          }
        })
        .catch(() => undefined);
    });
  }

  function sendRemoteMouseEvent(
    action: 'press' | 'motion' | 'release',
    pageX: number,
    pageY: number,
    gesture: number
  ) {
    terminalViewportRef.current?.measureInWindow((viewportX, viewportY, width, height) => {
      if (gesture !== remoteDragGestureRef.current) return;
      const x = pageX - viewportX;
      const y = pageY - viewportY;
      if (
        x < 0 || y < 0 || width < 1 || height < 1
        || dimensions.columns < 1 || dimensions.rows < 1
      ) return;

      const column = Math.floor(x * dimensions.columns / width) + 1;
      const row = Math.floor(y * dimensions.rows / height) + 1;
      if (column > dimensions.columns || row > dimensions.rows) return;
      const previous = remoteMouseLastCellRef.current;
      if (action === 'motion' && previous?.column === column && previous.row === row) return;
      remoteMouseLastCellRef.current = action === 'release' ? null : { column, row };
      remoteMouseWriteRef.current = remoteMouseWriteRef.current
        .then(() => manager.sendMouseEvent(column, row, action))
        .then(() => undefined)
        .catch(() => undefined);
    });
  }

  function sendTerminalTap(pageX: number, pageY: number) {
    terminalViewportRef.current?.measureInWindow((viewportX, viewportY, width, height) => {
      const x = pageX - viewportX;
      const y = pageY - viewportY;
      if (
        x < 0 || y < 0 || width < 1 || height < 1
        || dimensions.columns < 1 || dimensions.rows < 1
      ) return;

      const column = Math.floor(x * dimensions.columns / width) + 1;
      const row = Math.floor(y * dimensions.rows / height) + 1;
      if (column > dimensions.columns || row > dimensions.rows) return;
      if (session.mouseTracking) {
        focusDirectTerminalInput();
        void manager.sendMouseTap(column, row).catch(() => undefined);
        return;
      }
      void nativeTerminalRef.current?.hyperlinkAt(column, row)
        .then(uri => {
          if (!uri || !/^https?:\/\//i.test(uri)) {
            focusDirectTerminalInput();
            return manager.sendMouseTap(column, row).then(() => undefined);
          }
          Alert.alert(
            'Open terminal link?',
            uri,
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Open',
                onPress: () => {
                  void Linking.openURL(uri).catch(() => undefined);
                },
              },
            ]
          );
          return undefined;
        })
        .catch(() => {
          focusDirectTerminalInput();
        });
    });
  }

  function focusDirectTerminalInput() {
    if (
      !lineMode
      && !keyboardVisibleRef.current
      && !directInputFocusedRef.current
    ) {
      directInputRef.current?.focus();
    }
  }

  async function disconnectTerminal() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await manager.disconnect();
    } catch {
      setDisconnecting(false);
    }
  }

  async function pasteClipboard() {
    try {
      const text = await readClipboardText();
      if (text) {
        void manager.paste(text).catch(() => undefined);
      }
    } catch {
      // Clipboard access can be denied by the operating system. Keep the
      // terminal focused so the standard keyboard paste action remains usable.
      directInputRef.current?.focus();
    }
  }

  async function copyTerminalSelection() {
    await nativeTerminalRef.current?.copySelection().catch(() => false);
  }

  async function findTerminalText(backwards: boolean) {
    const query = searchQuery.trim();
    if (!query) return;
    const found = await nativeTerminalRef.current
      ?.findText(query, backwards)
      .catch(() => false);
    setSearchStatus(found ? '' : 'No match');
  }

  function toggleSearch() {
    setSearchOpen(value => {
      const next = !value;
      setSearchStatus('');
      if (next) {
        dismissTerminalKeyboard();
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else {
        searchInputRef.current?.blur();
        void nativeTerminalRef.current?.clearSelection();
      }
      return next;
    });
  }

  function toggleLineMode() {
    resetDirectInput();
    setLineMode(value => {
      const next = !value;
      if (next) setTimeout(() => lineInputRef.current?.focus(), 0);
      else setTimeout(() => directInputRef.current?.focus(), 0);
      return next;
    });
  }

  function dismissTerminalKeyboard() {
    directInputFocusedRef.current = false;
    directInputRef.current?.blur();
    lineInputRef.current?.blur();
    Keyboard.dismiss();
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior="padding"
        style={styles.flex}
      >
        <View style={styles.shell}>
          <View style={[
            styles.header,
            layout.shortViewport && styles.headerShort,
            layout.wide && styles.headerWide,
          ]}>
            <Pressable
              accessibilityLabel="Back to nodes"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.back()}
              style={[styles.backButton, layout.shortViewport && styles.backButtonShort]}
            >
              <Text style={[styles.back, layout.shortViewport && styles.backShort]}>‹</Text>
            </Pressable>
            <View style={styles.target}>
              <Text numberOfLines={1} style={styles.targetText}>
                {session.terminalTitle || (
                  <><Text style={styles.login}>{params.login}@</Text>{params.hostname}</>
                )}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <View style={styles.sessionState}>
                <Text style={styles.dimensions}>
                  {viewportReady ? `${dimensions.columns}×${dimensions.rows}` : 'measuring'}
                </Text>
                <View style={[styles.liveDot, !connected && styles.liveDotWaiting]} />
              </View>
              <Pressable
                accessibilityLabel="Disconnect terminal session"
                accessibilityRole="button"
                disabled={disconnecting}
                hitSlop={6}
                onPress={disconnectTerminal}
                style={({ pressed }) => [
                  styles.disconnectButton,
                  disconnecting && styles.disconnectButtonDisabled,
                  pressed && styles.disconnectButtonPressed,
                ]}
              >
                <Text style={styles.disconnectText}>
                  {disconnecting ? 'Closing…' : 'Disconnect'}
                </Text>
              </Pressable>
            </View>
          </View>

          <View
            ref={terminalViewportRef}
            onLayout={resizeTerminal}
            onTouchCancel={() => {
              if (selectionTimerRef.current) {
                clearTimeout(selectionTimerRef.current);
                selectionTimerRef.current = null;
              }
              if (remoteDragActiveRef.current) {
                const touch = terminalTouchRef.current;
                sendRemoteMouseEvent(
                  'release',
                  touch.lastPageX,
                  touch.lastPageY,
                  remoteDragGestureRef.current
                );
                remoteDragActiveRef.current = false;
              }
              selectionActiveRef.current = false;
              terminalTouchRef.current.moved = true;
            }}
            onTouchEnd={finishTerminalTouch}
            onTouchMove={moveTerminalTouch}
            onTouchStart={startTerminalTouch}
            style={styles.terminalViewport}
          >
            <ExpoTeleportTerminalView
              fallbackText={Platform.OS === 'web' ? session.fallbackText : undefined}
              fontSize={fontMetrics.fontSize}
              onDimensions={applyNativeDimensions}
              ref={nativeTerminalRef}
              sessionId={session.sessionId}
              style={styles.nativeTerminal}
            />

            {session.error ? (
              <View style={styles.errorBanner}>
                <Text numberOfLines={2} style={styles.errorText}>{session.error}</Text>
              </View>
            ) : null}

            <TextInput
              ref={directInputRef}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              caretHidden
              editable={connected && !lineMode}
              keyboardAppearance="dark"
              keyboardType={Platform.OS === 'android' ? 'visible-password' : 'ascii-capable'}
              onBlur={() => {
                directInputFocusedRef.current = false;
              }}
              onChangeText={sendTypedText}
              onFocus={() => {
                directInputFocusedRef.current = true;
              }}
              onKeyPress={event => {
                if (event.nativeEvent.key === 'Backspace') sendTerminalKey('backspace');
              }}
              onSubmitEditing={() => {
                sendTerminalKey('enter');
                resetDirectInput();
              }}
              returnKeyType="send"
              spellCheck={false}
              style={styles.directInput}
              submitBehavior="submit"
            />
          </View>

          <View style={styles.inputDock}>
            {searchOpen ? (
              <View style={styles.searchRow}>
                <Text style={styles.searchPrompt}>FIND</Text>
                <TextInput
                  ref={searchInputRef}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardAppearance="dark"
                  onChangeText={value => {
                    setSearchQuery(value);
                    setSearchStatus('');
                  }}
                  onSubmitEditing={() => findTerminalText(false)}
                  placeholder="search terminal buffer"
                  placeholderTextColor={palette.quiet}
                  returnKeyType="search"
                  selectionColor={palette.copper}
                  spellCheck={false}
                  style={styles.searchInput}
                  submitBehavior="submit"
                  value={searchQuery}
                />
                {searchStatus ? <Text style={styles.searchStatus}>{searchStatus}</Text> : null}
                <UtilityKey
                  accessibilityLabel="Previous search result"
                  dense
                  label="↑"
                  onPress={() => findTerminalText(true)}
                />
                <UtilityKey
                  accessibilityLabel="Next search result"
                  dense
                  label="↓"
                  onPress={() => findTerminalText(false)}
                />
                <UtilityKey
                  accessibilityLabel="Close terminal search"
                  dense
                  label="×"
                  onPress={toggleSearch}
                />
              </View>
            ) : null}
            <ScrollView
              contentContainerStyle={[
                styles.keyRail,
                layout.shortViewport && styles.keyRailShort,
                layout.wide && styles.keyRailWide,
              ]}
              horizontal
              keyboardShouldPersistTaps="always"
              showsHorizontalScrollIndicator={false}
            >
              {Platform.OS === 'ios' ? (
                <UtilityKey
                  accessibilityLabel="Dismiss keyboard"
                  dense={layout.shortViewport}
                  label="KB↓"
                  onPress={dismissTerminalKeyboard}
                />
              ) : null}
              <UtilityKey
                active={modifiers.ctrl}
                dense={layout.shortViewport}
                label="CTRL"
                onPress={() => toggleModifier('ctrl')}
                wide
              />
              <UtilityKey
                active={modifiers.alt}
                dense={layout.shortViewport}
                label="ALT"
                onPress={() => toggleModifier('alt')}
              />
              <UtilityKey dense={layout.shortViewport} label="PASTE" onPress={pasteClipboard} wide />
              <UtilityKey dense={layout.shortViewport} label="COPY" onPress={copyTerminalSelection} wide />
              <UtilityKey active={searchOpen} dense={layout.shortViewport} label="FIND" onPress={toggleSearch} wide />
              <UtilityKey active={lineMode} dense={layout.shortViewport} label="LINE" onPress={toggleLineMode} wide />
              {TERMINAL_KEYS.map(key => (
                <UtilityKey
                  key={key.key}
                  dense={layout.shortViewport}
                  label={key.label}
                  onPress={() => sendTerminalKey(key.key)}
                  wide={key.wide}
                />
              ))}
            </ScrollView>

            {lineMode ? (
              <View style={[
                styles.commandRow,
                layout.shortViewport && styles.commandRowShort,
              ]}>
                <Text style={styles.prompt}>$</Text>
                <TextInput
                  ref={lineInputRef}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={connected}
                  keyboardAppearance="dark"
                  onChangeText={setCommand}
                  onSubmitEditing={submitCommand}
                  placeholder={connected ? 'send a complete line' : 'connecting…'}
                  placeholderTextColor={palette.quiet}
                  returnKeyType="send"
                  selectionColor={palette.copper}
                  spellCheck={false}
                  style={styles.command}
                  submitBehavior="submit"
                  value={command}
                />
                <Pressable
                  accessibilityLabel="Send command"
                  accessibilityRole="button"
                  disabled={!connected || !command}
                  onPress={submitCommand}
                  style={({ pressed }) => [
                    styles.send,
                    (!connected || !command) && styles.sendDisabled,
                    pressed && styles.sendPressed,
                  ]}
                >
                  <Text style={styles.sendText}>↵</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function isActiveTerminalState(state: string) {
  return state === 'connecting'
    || state === 'connected'
    || state === 'checking'
    || state === 'reconnecting';
}

function UtilityKey({
  active = false,
  accessibilityLabel,
  dense = false,
  label,
  onPress,
  wide = false,
}: {
  active?: boolean;
  accessibilityLabel?: string;
  dense?: boolean;
  label: string;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        wide && styles.keyWide,
        dense && styles.keyDense,
        dense && wide && styles.keyWideDense,
        active && styles.keyActive,
        pressed && styles.keyPressed,
      ]}
    >
      <Text style={[
        styles.keyText,
        dense && styles.keyTextDense,
        active && styles.keyTextActive,
      ]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: palette.terminal },
  shell: { flex: 1, backgroundColor: palette.terminal },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomColor: palette.rule,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: palette.deep,
    paddingHorizontal: space.sm,
  },
  headerShort: { minHeight: 36, paddingHorizontal: space.xs },
  headerWide: { paddingHorizontal: space.md },
  backButton: { width: 40, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  backButtonShort: { width: 34 },
  back: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 30, lineHeight: 32 },
  backShort: { fontSize: 25, lineHeight: 27 },
  target: { flex: 1, minWidth: 0, alignItems: 'center' },
  targetText: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 11 },
  login: { color: palette.quiet, fontFamily: type.mono },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sessionState: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 7 },
  dimensions: { color: palette.quiet, fontFamily: type.mono, fontSize: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.signal },
  liveDotWaiting: { backgroundColor: palette.warning },
  disconnectButton: {
    minHeight: 28,
    justifyContent: 'center',
    borderColor: palette.danger,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.sm,
  },
  disconnectButtonDisabled: { opacity: 0.55 },
  disconnectButtonPressed: { backgroundColor: palette.raised },
  disconnectText: { color: palette.danger, fontFamily: type.monoMedium, fontSize: 9 },
  terminalViewport: { flex: 1, overflow: 'hidden', backgroundColor: palette.terminal },
  nativeTerminal: { flex: 1 },
  directInput: { position: 'absolute', width: 1, height: 1, left: 0, bottom: 0, opacity: 0 },
  errorBanner: {
    position: 'absolute',
    left: space.sm,
    right: space.sm,
    top: space.sm,
    borderLeftColor: palette.warning,
    borderLeftWidth: 3,
    backgroundColor: palette.deep,
    paddingHorizontal: space.sm,
    paddingVertical: 8,
  },
  errorText: { color: palette.warning, fontFamily: type.monoMedium, fontSize: 10, lineHeight: 14 },
  inputDock: { borderTopColor: palette.rule, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: palette.deep },
  searchRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderBottomColor: palette.rule,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 3,
  },
  searchPrompt: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 9 },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 32,
    color: palette.porcelain,
    fontFamily: type.mono,
    fontSize: 11,
    paddingHorizontal: space.xs,
    paddingVertical: 0,
  },
  searchStatus: { color: palette.warning, fontFamily: type.monoMedium, fontSize: 8 },
  keyRail: { minHeight: 38, alignItems: 'stretch', paddingHorizontal: 3, gap: 3 },
  keyRailShort: { minHeight: 32 },
  keyRailWide: { flexGrow: 1, justifyContent: 'center' },
  key: { width: 44, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderColor: palette.rule, borderWidth: StyleSheet.hairlineWidth, backgroundColor: palette.panel },
  keyWide: { width: 58 },
  keyDense: { width: 40, minHeight: 28 },
  keyWideDense: { width: 52 },
  keyActive: { borderColor: palette.copper, backgroundColor: palette.copperMuted },
  keyPressed: { backgroundColor: palette.raised },
  keyText: { color: palette.mist, fontFamily: type.monoMedium, fontSize: 9 },
  keyTextDense: { fontSize: 8 },
  keyTextActive: { color: palette.porcelain },
  commandRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', backgroundColor: palette.deep, paddingLeft: space.md },
  commandRowShort: { minHeight: 38, paddingLeft: space.sm },
  prompt: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 16 },
  command: { flex: 1, color: palette.porcelain, fontFamily: type.mono, fontSize: 13, paddingHorizontal: space.sm, paddingVertical: 0 },
  send: { alignSelf: 'stretch', minWidth: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.copper },
  sendDisabled: { backgroundColor: palette.raised },
  sendPressed: { opacity: 0.8 },
  sendText: { color: palette.ink, fontFamily: type.monoStrong, fontSize: 19 },
});
