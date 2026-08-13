import type { PropsWithChildren, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type StyleProp,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';

import { palette, radius, space, type } from '@/constants/tokens';

export function Eyebrow({ children }: PropsWithChildren) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function FieldLabel({ children }: PropsWithChildren) {
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

export function Field(props: TextInputProps) {
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor={palette.quiet}
      selectionColor={palette.copper}
      {...props}
      style={[styles.field, props.style]}
    />
  );
}

type PrimaryButtonProps = {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
};

export function PrimaryButton({
  children,
  onPress,
  disabled,
  loading,
  testID,
}: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.ink} />
      ) : (
        <Text style={styles.primaryButtonText}>{children}</Text>
      )}
    </Pressable>
  );
}

type ConnectionRailProps = {
  step: 1 | 2 | 3;
  labels?: [string, string, string];
};

export function ConnectionRail({
  step,
  labels = ['Identity', 'Resource', 'Shell'],
}: ConnectionRailProps) {
  return (
    <View style={styles.rail} accessibilityLabel={`Connection step ${step} of 3`}>
      {labels.map((label, index) => {
        const active = index + 1 <= step;
        return (
          <View key={label} style={styles.railItem}>
            <View style={[styles.railDot, active && styles.railDotActive]} />
            {index < labels.length - 1 && (
              <View style={[styles.railLine, active && styles.railLineActive]} />
            )}
            <Text style={[styles.railLabel, active && styles.railLabelActive]}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function Notice({ children, tone = 'quiet' }: PropsWithChildren<{ tone?: 'quiet' | 'error' }>) {
  return (
    <View style={[styles.notice, tone === 'error' && styles.noticeError]}>
      <Text style={[styles.noticeText, tone === 'error' && styles.noticeErrorText]}>
        {children}
      </Text>
    </View>
  );
}

export function Panel({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  eyebrow: {
    color: palette.copper,
    fontFamily: type.monoStrong,
    fontSize: 11,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  fieldLabel: {
    color: palette.mist,
    fontFamily: type.monoMedium,
    fontSize: 11,
    letterSpacing: 0.5,
    marginBottom: space.sm,
    textTransform: 'uppercase',
  },
  field: {
    minHeight: 54,
    borderColor: palette.rule,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: palette.porcelain,
    backgroundColor: palette.deep,
    fontFamily: type.mono,
    fontSize: 15,
    paddingHorizontal: space.md,
  },
  primaryButton: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.copper,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
  },
  primaryButtonText: {
    color: palette.ink,
    fontFamily: type.monoStrong,
    fontSize: 13,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  disabled: { opacity: 0.46 },
  rail: {
    flexDirection: 'row',
    minHeight: 52,
    alignItems: 'flex-start',
  },
  railItem: { flex: 1, position: 'relative', alignItems: 'flex-start' },
  railDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: palette.quiet,
    backgroundColor: palette.ink,
    zIndex: 2,
  },
  railDotActive: { borderColor: palette.copper, backgroundColor: palette.copper },
  railLine: {
    position: 'absolute',
    top: 4,
    left: 10,
    right: 0,
    height: 1,
    backgroundColor: palette.rule,
  },
  railLineActive: { backgroundColor: palette.copperMuted },
  railLabel: {
    marginTop: space.sm,
    color: palette.quiet,
    fontFamily: type.mono,
    fontSize: 10,
    letterSpacing: 0.4,
  },
  railLabelActive: { color: palette.mist },
  notice: {
    borderLeftColor: palette.copperMuted,
    borderLeftWidth: 2,
    paddingLeft: space.md,
    paddingVertical: space.xs,
  },
  noticeText: {
    color: palette.quiet,
    fontFamily: type.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  noticeError: { borderLeftColor: palette.danger },
  noticeErrorText: { color: palette.danger },
  panel: {
    borderColor: palette.rule,
    borderWidth: 1,
    borderRadius: radius.md,
    backgroundColor: palette.panel,
    padding: space.md,
  },
});
