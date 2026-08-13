import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palette, space, type } from '@/constants/tokens';
import { readClipboardText } from '@/lib/platform/clipboard';
import {
  TERMINAL_KEYS,
  terminalKeySequence,
  terminalTextSequence,
  type TerminalModifiers,
} from '@/lib/terminal/keys';
import { getTerminalSessionManager } from '@/lib/terminal/session-manager';

const MAX_TERMINAL_FONT_SIZE = 13;
const MIN_TERMINAL_COLUMNS = 84;
const TERMINAL_CELL_WIDTH_RATIO = 0.6;
const TERMINAL_LINE_HEIGHT_RATIO = 20 / 13;
const TERMINAL_PADDING = 12;
const INITIAL_SIZE = { columns: MIN_TERMINAL_COLUMNS, rows: 40 };
const INITIAL_FONT_METRICS = { fontSize: 7.5, lineHeight: 7.5 * TERMINAL_LINE_HEIGHT_RATIO };

export default function TerminalScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId: string;
    hostname: string;
    login: string;
  }>();
  const [manager] = useState(getTerminalSessionManager);
  const [session, setSession] = useState(manager.getSnapshot);
  const [dimensions, setDimensions] = useState(INITIAL_SIZE);
  const [fontMetrics, setFontMetrics] = useState(INITIAL_FONT_METRICS);
  const [command, setCommand] = useState('');
  const [lineMode, setLineMode] = useState(false);
  const [modifiers, setModifiers] = useState<TerminalModifiers>({ ctrl: false, alt: false });
  const dimensionsRef = useRef(INITIAL_SIZE);
  const scrollRef = useRef<ScrollView>(null);
  const directInputRef = useRef<TextInput>(null);
  const directInputValueRef = useRef('');
  const lineInputRef = useRef<TextInput>(null);
  const connected = session.state === 'connected';

  useEffect(() => {
    const unsubscribe = manager.subscribe(setSession);
    manager.attach({
      serverId: params.serverId,
      hostname: params.hostname,
      login: params.login,
      ...dimensionsRef.current,
    }, dimensionsRef.current);
    return () => {
      unsubscribe();
      manager.detach();
    };
  }, [manager, params.hostname, params.login, params.serverId]);

  function resizeTerminal(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    const availableWidth = Math.max(1, width - TERMINAL_PADDING * 2);
    const availableHeight = Math.max(1, height - TERMINAL_PADDING * 2);
    const fontSize = Math.min(
      MAX_TERMINAL_FONT_SIZE,
      availableWidth / (MIN_TERMINAL_COLUMNS * TERMINAL_CELL_WIDTH_RATIO)
    );
    const cellWidth = fontSize * TERMINAL_CELL_WIDTH_RATIO;
    const lineHeight = fontSize * TERMINAL_LINE_HEIGHT_RATIO;
    const next = {
      columns: Math.max(MIN_TERMINAL_COLUMNS, Math.floor(availableWidth / cellWidth)),
      rows: Math.max(8, Math.floor(availableHeight / lineHeight)),
    };
    setFontMetrics(current =>
      Math.abs(current.fontSize - fontSize) < 0.01
        && Math.abs(current.lineHeight - lineHeight) < 0.01
        ? current
        : { fontSize, lineHeight }
    );
    const current = dimensionsRef.current;
    if (next.columns === current.columns && next.rows === current.rows) return;

    dimensionsRef.current = next;
    setDimensions(next);
    manager.resize(next.columns, next.rows);
  }

  async function submitCommand() {
    if (!connected || !command) return;
    const value = `${command}\r`;
    setCommand('');
    await manager.send(value).catch(() => undefined);
  }

  function sendRaw(value: string) {
    if (!connected) return;
    void manager.send(value).catch(() => undefined);
  }

  function sendTerminalKey(key: string) {
    const sequence = terminalKeySequence(key, modifiers);
    if (sequence) sendRaw(sequence);
  }

  function sendTypedText(nextText: string) {
    const previousText = directInputValueRef.current;
    directInputValueRef.current = nextText;
    if (nextText.length <= previousText.length) return;

    const insertedText = nextText.startsWith(previousText)
      ? nextText.slice(previousText.length)
      : nextText;
    const sequence = terminalTextSequence(insertedText, modifiers);
    if (sequence) sendRaw(sequence);
    if (nextText.length >= 128) resetDirectInput();
  }

  function resetDirectInput() {
    directInputValueRef.current = '';
    directInputRef.current?.clear();
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

  function toggleLineMode() {
    resetDirectInput();
    setLineMode(value => {
      const next = !value;
      if (next) setTimeout(() => lineInputRef.current?.focus(), 0);
      else setTimeout(() => directInputRef.current?.focus(), 0);
      return next;
    });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior="padding"
        style={styles.flex}
      >
        <View style={styles.shell}>
          <View style={styles.header}>
            <Pressable
              accessibilityLabel="Back to nodes"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.back()}
              style={styles.backButton}
            >
              <Text style={styles.back}>‹</Text>
            </Pressable>
            <View style={styles.target}>
              <Text numberOfLines={1} style={styles.targetText}>
                <Text style={styles.login}>{params.login}@</Text>{params.hostname}
              </Text>
            </View>
            <View style={styles.sessionState}>
              <Text style={styles.dimensions}>{dimensions.columns}×{dimensions.rows}</Text>
              <View style={[styles.liveDot, !connected && styles.liveDotWaiting]} />
            </View>
          </View>

          <View
            onLayout={resizeTerminal}
            onTouchStart={() => directInputRef.current?.focus()}
            style={styles.terminalViewport}
          >
            <ScrollView
              ref={scrollRef}
              contentContainerStyle={styles.terminalContent}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
              {session.lines.map((line, lineIndex) => (
                <Text
                  allowFontScaling={false}
                  key={lineIndex}
                  selectable
                  style={[
                    styles.outputLine,
                    { fontSize: fontMetrics.fontSize, lineHeight: fontMetrics.lineHeight },
                  ]}
                >
                  {line.runs.map((run, runIndex) => (
                    <Text
                      allowFontScaling={false}
                      key={runIndex}
                      style={{
                        backgroundColor: run.backgroundColor,
                        color: run.color,
                        fontFamily: run.bold ? type.monoStrong : type.mono,
                        fontStyle: run.italic ? 'italic' : 'normal',
                        opacity: run.dim ? 0.65 : 1,
                        textDecorationLine: run.decoration,
                      }}
                    >
                      {run.text}
                    </Text>
                  ))}
                </Text>
              ))}
            </ScrollView>

            {session.error ? (
              <View style={styles.errorBanner}>
                <Text numberOfLines={2} style={styles.errorText}>{session.error}</Text>
              </View>
            ) : null}

            <TextInput
              ref={directInputRef}
              autoCapitalize="none"
              autoCorrect={false}
              caretHidden
              editable={connected && !lineMode}
              keyboardAppearance="dark"
              onChangeText={sendTypedText}
              onKeyPress={event => {
                if (event.nativeEvent.key === 'Backspace') sendTerminalKey('backspace');
              }}
              onSubmitEditing={() => {
                sendRaw('\r');
                resetDirectInput();
              }}
              returnKeyType="send"
              spellCheck={false}
              style={styles.directInput}
            />
          </View>

          <View style={styles.inputDock}>
            <ScrollView
              contentContainerStyle={styles.keyRail}
              horizontal
              keyboardShouldPersistTaps="always"
              showsHorizontalScrollIndicator={false}
            >
              <UtilityKey
                active={modifiers.ctrl}
                label="CTRL"
                onPress={() => setModifiers(value => ({ ...value, ctrl: !value.ctrl }))}
                wide
              />
              <UtilityKey
                active={modifiers.alt}
                label="ALT"
                onPress={() => setModifiers(value => ({ ...value, alt: !value.alt }))}
              />
              <UtilityKey label="PASTE" onPress={pasteClipboard} wide />
              <UtilityKey active={lineMode} label="LINE" onPress={toggleLineMode} wide />
              {TERMINAL_KEYS.map(key => (
                <UtilityKey
                  key={key.key}
                  label={key.label}
                  onPress={() => sendTerminalKey(key.key)}
                  wide={key.wide}
                />
              ))}
            </ScrollView>

            {lineMode ? (
              <View style={styles.commandRow}>
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

function UtilityKey({
  active = false,
  label,
  onPress,
  wide = false,
}: {
  active?: boolean;
  label: string;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        wide && styles.keyWide,
        active && styles.keyActive,
        pressed && styles.keyPressed,
      ]}
    >
      <Text style={[styles.keyText, active && styles.keyTextActive]}>{label}</Text>
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
  backButton: { width: 40, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  back: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 30, lineHeight: 32 },
  target: { flex: 1, minWidth: 0, alignItems: 'center' },
  targetText: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 11 },
  login: { color: palette.quiet, fontFamily: type.mono },
  sessionState: { width: 52, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 7 },
  dimensions: { color: palette.quiet, fontFamily: type.mono, fontSize: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.signal },
  liveDotWaiting: { backgroundColor: palette.warning },
  terminalViewport: { flex: 1, backgroundColor: palette.terminal },
  terminalContent: { padding: TERMINAL_PADDING, flexGrow: 1 },
  outputLine: { color: palette.porcelain, fontFamily: type.mono },
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
  keyRail: { minHeight: 38, alignItems: 'stretch', paddingHorizontal: 3, gap: 3 },
  key: { width: 44, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderColor: palette.rule, borderWidth: StyleSheet.hairlineWidth, backgroundColor: palette.panel },
  keyWide: { width: 58 },
  keyActive: { borderColor: palette.copper, backgroundColor: palette.copperMuted },
  keyPressed: { backgroundColor: palette.raised },
  keyText: { color: palette.mist, fontFamily: type.monoMedium, fontSize: 9 },
  keyTextActive: { color: palette.porcelain },
  commandRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', backgroundColor: palette.deep, paddingLeft: space.md },
  prompt: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 16 },
  command: { flex: 1, color: palette.porcelain, fontFamily: type.mono, fontSize: 13, paddingHorizontal: space.sm, paddingVertical: 0 },
  send: { alignSelf: 'stretch', minWidth: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.copper },
  sendDisabled: { backgroundColor: palette.raised },
  sendPressed: { opacity: 0.8 },
  sendText: { color: palette.ink, fontFamily: type.monoStrong, fontSize: 19 },
});
