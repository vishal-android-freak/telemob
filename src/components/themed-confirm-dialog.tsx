import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, radius, space, type } from '@/constants/tokens';

export function ThemedConfirmDialog({
  busy = false,
  cancelLabel = 'Cancel',
  confirmLabel,
  eyebrow,
  message,
  onCancel,
  onConfirm,
  tone = 'danger',
  title,
  visible,
}: {
  busy?: boolean;
  cancelLabel?: string;
  confirmLabel: string;
  eyebrow: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
  tone?: 'accent' | 'danger';
  title: string;
  visible: boolean;
}) {
  return (
    <Modal
      animationType="fade"
      onRequestClose={busy ? undefined : onCancel}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <Pressable
          accessibilityLabel="Close confirmation"
          accessibilityRole="button"
          disabled={busy}
          onPress={onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View accessibilityRole="alert" style={styles.dialog}>
          <View style={styles.signalRow}>
            <View style={[styles.signalDot, tone === 'accent' && styles.signalDotAccent]} />
            <Text style={[styles.eyebrow, tone === 'accent' && styles.eyebrowAccent]}>{eyebrow}</Text>
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.rule} />
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onCancel}
              style={({ pressed }) => [
                styles.action,
                styles.cancelAction,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.action,
                styles.confirmAction,
                tone === 'accent' && styles.confirmActionAccent,
                busy && styles.busy,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.confirmText}>{busy ? 'Working…' : confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(5, 9, 13, 0.82)',
    padding: space.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 420,
    borderColor: palette.rule,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    backgroundColor: palette.panel,
    padding: space.lg,
  },
  signalRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: space.sm },
  signalDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.danger },
  signalDotAccent: { backgroundColor: palette.copper },
  eyebrow: {
    color: palette.danger,
    fontFamily: type.monoStrong,
    fontSize: 9,
    letterSpacing: 1.6,
  },
  eyebrowAccent: { color: palette.copper },
  title: {
    color: palette.porcelain,
    fontFamily: type.displayStrong,
    fontSize: 26,
    lineHeight: 31,
  },
  message: {
    color: palette.mist,
    fontFamily: type.mono,
    fontSize: 11,
    lineHeight: 18,
    marginTop: space.sm,
  },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: palette.rule, marginVertical: space.lg },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  action: {
    minHeight: 42,
    minWidth: 108,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
  },
  cancelAction: { borderColor: palette.rule, borderWidth: StyleSheet.hairlineWidth },
  confirmAction: { backgroundColor: palette.danger },
  confirmActionAccent: { backgroundColor: palette.copper },
  cancelText: { color: palette.mist, fontFamily: type.monoMedium, fontSize: 10 },
  confirmText: { color: palette.terminal, fontFamily: type.monoStrong, fontSize: 10 },
  busy: { opacity: 0.6 },
  pressed: { opacity: 0.72 },
});
