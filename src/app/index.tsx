import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  ConnectionRail,
  Eyebrow,
  Field,
  FieldLabel,
  Notice,
  PrimaryButton,
} from '@/components/shell-ui';
import { palette, radius, space, type } from '@/constants/tokens';
import { getTeleportClient } from '@/lib/teleport/client';
import {
  clearProfile,
  loadSessionSnapshot,
  saveProfile,
  saveSessionSnapshot,
} from '@/lib/teleport/profile-store';
import type {
  AuthChallenge,
  AuthenticatedProfile,
  AuthMethod,
  TeleportCapabilities,
} from '@/types/teleport';

export default function ConnectScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ reason?: string }>();
  const [proxyAddress, setProxyAddress] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [method, setMethod] = useState<AuthMethod>('passkey');
  const [insecure, setInsecure] = useState(false);
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null);
  const [totp, setTotp] = useState('');
  const [error, setError] = useState(
    params.reason === 'session-expired'
      ? 'Your Teleport session expired. Sign in again to continue.'
      : ''
  );
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [capabilities, setCapabilities] =
    useState<TeleportCapabilities | null>(null);

  useEffect(() => {
    let mounted = true;
    getTeleportClient()
      .capabilities()
      .then(next => {
        if (mounted) setCapabilities(next);
      })
      .catch(() => {
        // Login will surface a useful error if the native core is unavailable.
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    async function restoreLogin() {
      try {
        const snapshot = await loadSessionSnapshot();
        if (!snapshot) return;
        const profile = await getTeleportClient().restoreSession(snapshot);
        await saveProfile(profile);
        if (mounted) router.replace('/servers');
      } catch {
        await clearProfile();
      } finally {
        if (mounted) setRestoring(false);
      }
    }
    void restoreLogin();
    return () => {
      mounted = false;
    };
  }, [router]);

  async function persistLogin(profile: AuthenticatedProfile) {
    const snapshot = await getTeleportClient().exportSession();
    await Promise.all([saveProfile(profile), saveSessionSnapshot(snapshot)]);
  }

  async function beginLogin() {
    setError('');
    setLoading(true);
    try {
      const next = await getTeleportClient().beginLogin({
        proxyAddress,
        username,
        password,
        method,
        insecure,
      });
      setChallenge(next);
      if (next.kind === 'passkey') {
        await finishPasskey(next);
      }
    } catch (loginError) {
      setError(messageFrom(loginError));
    } finally {
      setLoading(false);
    }
  }

  async function finishPasskey(next = challenge) {
    if (!next || next.kind !== 'passkey') return;
    setError('');
    setLoading(true);
    try {
      const profile = await getTeleportClient().finishPasskey(next.challengeId);
      await persistLogin(profile);
      router.replace('/servers');
    } catch (loginError) {
      setError(messageFrom(loginError));
    } finally {
      setLoading(false);
    }
  }

  async function finishTotp() {
    if (!challenge || challenge.kind !== 'totp') return;
    setError('');
    setLoading(true);
    try {
      const profile = await getTeleportClient().finishTotp(
        challenge.challengeId,
        totp
      );
      await persistLogin(profile);
      router.replace('/servers');
    } catch (loginError) {
      setError(messageFrom(loginError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior="padding"
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.masthead}>
            <Image
              accessibilityLabel="Telemob app icon"
              source={require('../../assets/images/icon.png')}
              style={styles.mark}
            />
            <View>
              <Text style={styles.product}>Telemob</Text>
              <Text style={styles.version}>mobile access / build 001</Text>
            </View>
          </View>

          <ConnectionRail step={1} />

          <View style={styles.hero}>
            <Eyebrow>Identity checkpoint</Eyebrow>
            <Text style={styles.title}>Your infrastructure, within reach.</Text>
            <Text style={styles.subtitle}>
              Enter the Teleport gateway you already trust. Credentials remain
              on this device and expire with the cluster certificate.
            </Text>
          </View>

          <View style={styles.form}>
            <View>
              <FieldLabel>Teleport gateway</FieldLabel>
              <Field
                value={proxyAddress}
                onChangeText={setProxyAddress}
                placeholder="teleport.example.com:443"
                keyboardType="url"
                textContentType="URL"
              />
            </View>
            <View>
              <FieldLabel>Username</FieldLabel>
              <Field
                value={username}
                onChangeText={setUsername}
                placeholder="operator"
                textContentType="username"
              />
            </View>
            <View>
              <FieldLabel>Password</FieldLabel>
              <Field
                value={password}
                onChangeText={setPassword}
                placeholder="Teleport password"
                secureTextEntry
                textContentType="password"
              />
            </View>

            <View>
              <FieldLabel>Second factor</FieldLabel>
              <View style={styles.methodRow}>
                <MethodButton
                  label="Passkey"
                  detail="Face ID / device unlock"
                  active={method === 'passkey'}
                  onPress={() => {
                    setMethod('passkey');
                    setChallenge(null);
                  }}
                />
                <MethodButton
                  label="TOTP"
                  detail="6-digit authenticator code"
                  active={method === 'totp'}
                  onPress={() => {
                    setMethod('totp');
                    setChallenge(null);
                  }}
                />
              </View>
            </View>

            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: insecure }}
              onPress={() => setInsecure(value => !value)}
              style={({ pressed }) => [
                styles.insecureOption,
                insecure && styles.insecureOptionActive,
                pressed && styles.methodPressed,
              ]}
            >
              <View style={[styles.checkbox, insecure && styles.checkboxActive]}>
                {insecure ? <Text style={styles.checkmark}>✓</Text> : null}
              </View>
              <View style={styles.insecureCopy}>
                <Text style={styles.insecureLabel}>Trust self-signed certificate</Text>
                <Text style={styles.insecureDetail}>
                  Skip TLS certificate and hostname verification
                </Text>
              </View>
            </Pressable>

            {insecure ? (
              <Notice tone="error">
                Insecure TLS is enabled. A hostile network could impersonate this
                Teleport proxy. Use only for a cluster you trust.
              </Notice>
            ) : null}

            {challenge?.kind === 'totp' && (
              <View>
                <FieldLabel>Authenticator code</FieldLabel>
                <Field
                  value={totp}
                  onChangeText={value => setTotp(value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  keyboardType="number-pad"
                  maxLength={6}
                  style={styles.totpField}
                />
              </View>
            )}

            {error ? <Notice tone="error">{error}</Notice> : null}

            <PrimaryButton
              loading={loading || restoring}
              onPress={challenge?.kind === 'totp' ? finishTotp : beginLogin}
              testID="connect-button"
            >
              {challenge?.kind === 'totp'
                ? 'Verify code'
                : restoring
                  ? 'Restoring login'
                : method === 'passkey'
                  ? 'Continue with passkey'
                  : 'Continue'}
            </PrimaryButton>
          </View>

          <Notice>
            {capabilities?.developmentDriver
              ? 'Development driver active. No password is written to storage.'
              : 'Native Go core active. Authentication and SSH traffic go directly between this device and your Teleport proxy.'}
          </Notice>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MethodButton({
  label,
  detail,
  active,
  onPress,
}: {
  label: string;
  detail: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.method,
        active && styles.methodActive,
        pressed && styles.methodPressed,
      ]}
    >
      <View style={[styles.radio, active && styles.radioActive]} />
      <Text style={[styles.methodLabel, active && styles.methodLabelActive]}>
        {label}
      </Text>
      <Text style={styles.methodDetail}>{detail}</Text>
    </Pressable>
  );
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : 'Authentication could not continue.';
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: palette.ink },
  content: { padding: space.lg, paddingBottom: space.xxl, gap: space.xl },
  masthead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mark: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
  },
  product: { color: palette.porcelain, fontFamily: type.displayStrong, fontSize: 19 },
  version: { color: palette.quiet, fontFamily: type.mono, fontSize: 9, letterSpacing: 0.7 },
  hero: { gap: space.sm },
  title: {
    color: palette.porcelain,
    fontFamily: type.display,
    fontSize: 43,
    lineHeight: 44,
    letterSpacing: -1.1,
    maxWidth: 360,
  },
  subtitle: {
    color: palette.mist,
    fontFamily: type.displayRegular,
    fontSize: 17,
    lineHeight: 24,
    maxWidth: 420,
  },
  form: { gap: space.lg },
  methodRow: { flexDirection: 'row', gap: space.sm },
  method: {
    flex: 1,
    minHeight: 94,
    borderColor: palette.rule,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: space.md,
    backgroundColor: palette.deep,
  },
  methodActive: { borderColor: palette.copper, backgroundColor: palette.panel },
  methodPressed: { opacity: 0.8 },
  radio: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderColor: palette.quiet,
    borderWidth: 1,
    marginBottom: space.sm,
  },
  radioActive: { backgroundColor: palette.copper, borderColor: palette.copper },
  methodLabel: { color: palette.mist, fontFamily: type.monoStrong, fontSize: 13 },
  methodLabelActive: { color: palette.porcelain },
  methodDetail: { color: palette.quiet, fontFamily: type.mono, fontSize: 10, lineHeight: 15, marginTop: 3 },
  insecureOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderColor: palette.rule,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: space.md,
    backgroundColor: palette.deep,
  },
  insecureOptionActive: { borderColor: palette.danger },
  checkbox: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: palette.quiet,
    borderWidth: 1,
    borderRadius: 4,
  },
  checkboxActive: { backgroundColor: palette.danger, borderColor: palette.danger },
  checkmark: { color: palette.ink, fontFamily: type.monoStrong, fontSize: 14 },
  insecureCopy: { flex: 1, gap: 2 },
  insecureLabel: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 12 },
  insecureDetail: { color: palette.quiet, fontFamily: type.mono, fontSize: 10, lineHeight: 15 },
  totpField: { fontSize: 23, letterSpacing: 8, textAlign: 'center' },
});
