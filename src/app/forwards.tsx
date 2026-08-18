import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Field, FieldLabel, Notice, Panel, PrimaryButton } from '@/components/shell-ui';
import { ThemedConfirmDialog } from '@/components/themed-confirm-dialog';
import { palette, radius, space, type } from '@/constants/tokens';
import {
  loadForwardRules,
  removeForwardRule,
  saveForwardRule,
  type SavedForwardRule,
  updateForwardRule,
} from '@/lib/teleport/forward-store';
import { withSavedProfile } from '@/lib/teleport/profile-session';
import { loadActiveSavedProfile } from '@/lib/teleport/profile-store';
import { getTeleportClient } from '@/lib/teleport/client';
import type {
  AuthChallenge,
  AuthMethod,
  LocalForward,
  LocalForwardRequest,
  SavedTeleportProfile,
} from '@/types/teleport';

export default function PortForwardsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId?: string;
    hostname?: string;
    login?: string;
    clusterName?: string;
  }>();
  const [profile, setProfile] = useState<SavedTeleportProfile | null>(null);
  const [active, setActive] = useState<LocalForward[]>([]);
  const [rules, setRules] = useState<SavedForwardRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [remoteHost, setRemoteHost] = useState('127.0.0.1');
  const [remotePort, setRemotePort] = useState('');
  const [localPort, setLocalPort] = useState('0');
  const [pendingRequest, setPendingRequest] = useState<LocalForwardRequest | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('totp');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [stopTarget, setStopTarget] = useState<LocalForward | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedForwardRule | null>(null);
  const [editingRule, setEditingRule] = useState<SavedForwardRule | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const profileIdRef = useRef<string | null>(null);

  const selectedNode = Boolean(params.serverId && params.hostname && params.login);
  const showForwardForm = selectedNode || Boolean(editingRule);
  const reload = useCallback(async () => {
    const nextProfile = await loadActiveSavedProfile();
    if (!nextProfile) {
      router.replace('/' as Href);
      return;
    }
    const [nextActive, nextRules] = await Promise.all([
      withSavedProfile(nextProfile.id, client => client.listLocalForwards()),
      loadForwardRules(nextProfile.id),
    ]);
    profileIdRef.current = nextProfile.id;
    setProfile(nextProfile);
    setAuthMethod(nextProfile.authMethod);
    setActive(nextActive.filter(forward => forward.profileId === nextProfile.id));
    setRules(nextRules);
  }, [router]);

  useEffect(() => {
    let mounted = true;
    const loadTimer = setTimeout(() => {
      void reload()
        .catch(loadError => mounted && setError(messageFrom(loadError)))
        .finally(() => mounted && setLoading(false));
    }, 0);
    const unsubscribe = getTeleportClient().subscribe(event => {
      if (event.type !== 'forward') return;
      if (event.forward.profileId !== profileIdRef.current) return;
      setActive(current => {
        const without = current.filter(forward => forward.id !== event.forward.id);
        return event.forward.state === 'listening' || event.forward.state === 'connecting'
          ? [...without, event.forward]
          : without;
      });
      if (event.forward.error) setError(event.forward.error);
    });
    return () => {
      mounted = false;
      profileIdRef.current = null;
      clearTimeout(loadTimer);
      unsubscribe();
    };
  }, [reload]);

  function buildRequest(): LocalForwardRequest | null {
    if (!profile) return null;
    const serverId = editingRule?.serverId || params.serverId;
    const hostname = editingRule?.hostname || params.hostname;
    const login = editingRule?.login || params.login;
    if (!serverId || !hostname || !login) return null;
    const parsedRemotePort = Number(remotePort);
    const parsedLocalPort = Number(localPort || '0');
    if (!Number.isInteger(parsedRemotePort) || parsedRemotePort < 1 || parsedRemotePort > 65535) {
      setError('Remote port must be between 1 and 65535.');
      return null;
    }
    if (!Number.isInteger(parsedLocalPort) || parsedLocalPort < 0 || parsedLocalPort > 65535) {
      setError('Local port must be 0 (automatic) or between 1 and 65535.');
      return null;
    }
    if (!remoteHost.trim()) {
      setError('Enter the host that the selected node should connect to.');
      return null;
    }
    return {
      name: name.trim() || `${hostname}:${parsedRemotePort}`,
      profileId: profile.id,
      serverId,
      hostname,
      login,
      clusterName: editingRule?.clusterName || params.clusterName || profile.profile.clusterName,
      remoteHost: remoteHost.trim(),
      remotePort: parsedRemotePort,
      localPort: parsedLocalPort,
    };
  }

  function resetForwardForm() {
    setName('');
    setRemoteHost('127.0.0.1');
    setRemotePort('');
    setLocalPort('0');
    setEditingRule(null);
  }

  function beginEditingRule(rule: SavedForwardRule) {
    setName(rule.name);
    setRemoteHost(rule.remoteHost);
    setRemotePort(String(rule.remotePort));
    setLocalPort(String(rule.localPort));
    setEditingRule(rule);
    setError('');
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));
  }

  async function requestStart(request: LocalForwardRequest, save = false) {
    if (!profile) return;
    setBusy(true);
    setError('');
    try {
      const status = await withSavedProfile(
        profile.id,
        client => client.forwardAuthorizationStatus()
      );
      if (!status.authorized) {
        setPendingRequest(request);
        setPendingSave(save);
        setChallenge(null);
        setPassword('');
        setTotp('');
        return;
      }
      const started = await withSavedProfile(
        profile.id,
        client => client.startLocalForward(request)
      );
      setActive(current => [...current.filter(value => value.id !== started.id), started]);
      if (save) {
        setRules(await saveForwardRule(request));
        resetForwardForm();
      }
    } catch (startError) {
      setError(messageFrom(startError));
    } finally {
      setBusy(false);
    }
  }

  async function authorize() {
    if (!profile || !pendingRequest) return;
    setBusy(true);
    setError('');
    try {
      if (!challenge) {
        const nextChallenge = await withSavedProfile(profile.id, client =>
          client.beginForwardAuthorization({
            password,
            method: authMethod,
            profileId: profile.id,
          })
        );
        if (nextChallenge.kind === 'totp') {
          setChallenge(nextChallenge);
          return;
        }
        await withSavedProfile(
          profile.id,
          client => client.finishForwardPasskey(nextChallenge.challengeId)
        );
      } else if (challenge.kind === 'totp') {
        await withSavedProfile(
          profile.id,
          client => client.finishForwardTotp(challenge.challengeId, totp)
        );
      }
      const request = pendingRequest;
      const save = pendingSave;
      setPendingRequest(null);
      setPendingSave(false);
      setChallenge(null);
      setPassword('');
      setTotp('');
      await requestStart(request, save);
    } catch (authorizationError) {
      setError(messageFrom(authorizationError));
    } finally {
      setBusy(false);
    }
  }

  async function stopForward() {
    if (!profile || !stopTarget) return;
    setBusy(true);
    try {
      await withSavedProfile(profile.id, client => client.stopLocalForward(stopTarget.id));
      setActive(current => current.filter(forward => forward.id !== stopTarget.id));
      setStopTarget(null);
    } catch (stopError) {
      setError(messageFrom(stopError));
    } finally {
      setBusy(false);
    }
  }

  async function saveEditedRule() {
    if (!profile || !editingRule) return;
    const request = buildRequest();
    if (!request) return;
    setBusy(true);
    setError('');
    try {
      setRules(await updateForwardRule(profile.id, editingRule.id, request));
      resetForwardForm();
    } catch (saveError) {
      setError(messageFrom(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule() {
    if (!profile || !deleteTarget) return;
    setBusy(true);
    setError('');
    try {
      setRules(await removeForwardRule(profile.id, deleteTarget.id));
      if (editingRule?.id === deleteTarget.id) resetForwardForm();
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(messageFrom(deleteError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ref={scrollRef}
        >
          <View style={styles.page}>
            <View style={styles.header}>
              <Pressable
                accessibilityLabel="Back to nodes"
                accessibilityRole="button"
                onPress={() => router.back()}
                style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
              >
                <Text style={styles.backText}>‹</Text>
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>LOCAL TCP</Text>
                <Text style={styles.title}>Port forwards</Text>
              </View>
            </View>

            <Notice>
              Listeners bind only to 127.0.0.1. Traffic reaches the destination from the selected Teleport node.
            </Notice>
            {error ? <Notice tone="error">{error}</Notice> : null}
            {loading ? <ActivityIndicator color={palette.copper} /> : null}

            {pendingRequest ? (
              <Panel style={styles.section}>
                <Text style={styles.sectionTitle}>Authorize SSH forwarding</Text>
                <Text style={styles.supporting}>
                  Teleport requires a temporary SSH certificate for port forwarding. Your password is never saved.
                </Text>
                {!challenge ? (
                  <>
                    <View style={styles.authMethods}>
                      {(['totp', 'passkey'] as AuthMethod[]).map(method => (
                        <Pressable
                          accessibilityRole="radio"
                          accessibilityState={{ selected: authMethod === method }}
                          key={method}
                          onPress={() => setAuthMethod(method)}
                          style={({ pressed }) => [
                            styles.authMethod,
                            authMethod === method && styles.authMethodActive,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text style={[
                            styles.authMethodText,
                            authMethod === method && styles.authMethodTextActive,
                          ]}>
                            {method === 'totp' ? 'Authenticator' : 'Passkey'}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <View>
                      <FieldLabel>Teleport password</FieldLabel>
                      <Field
                        onChangeText={setPassword}
                        onSubmitEditing={() => void authorize()}
                        secureTextEntry
                        value={password}
                      />
                    </View>
                  </>
                ) : challenge.kind === 'totp' ? (
                  <View>
                    <FieldLabel>Authenticator code</FieldLabel>
                    <Field
                      autoFocus
                      keyboardType="number-pad"
                      maxLength={6}
                      onChangeText={setTotp}
                      onSubmitEditing={() => void authorize()}
                      value={totp}
                    />
                  </View>
                ) : null}
                <PrimaryButton
                  disabled={!challenge ? !password : challenge.kind === 'totp' && totp.length !== 6}
                  loading={busy}
                  onPress={() => void authorize()}
                >
                  {!challenge ? `Continue with ${authMethod}` : 'Authorize & start'}
                </PrimaryButton>
                <Pressable
                  onPress={() => {
                    setPendingRequest(null);
                    setPendingSave(false);
                    setChallenge(null);
                  }}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryText}>Cancel</Text>
                </Pressable>
              </Panel>
            ) : null}

            {showForwardForm && !pendingRequest ? (
              <Panel style={styles.section}>
                <View>
                  <Text style={styles.sectionTitle}>{editingRule ? 'Edit saved forward' : 'New forward'}</Text>
                  <Text style={styles.target}>
                    {editingRule ? `${editingRule.login}@${editingRule.hostname}` : `${params.login}@${params.hostname}`}
                  </Text>
                </View>
                <View>
                  <FieldLabel>Name (optional)</FieldLabel>
                  <Field onChangeText={setName} placeholder="Local database" value={name} />
                </View>
                <View style={styles.fieldPair}>
                  <View style={styles.hostField}>
                    <FieldLabel>Remote host</FieldLabel>
                    <Field onChangeText={setRemoteHost} value={remoteHost} />
                  </View>
                  <View style={styles.portField}>
                    <FieldLabel>Remote port</FieldLabel>
                    <Field keyboardType="number-pad" onChangeText={setRemotePort} placeholder="5432" value={remotePort} />
                  </View>
                </View>
                <View>
                  <FieldLabel>Local port</FieldLabel>
                  <Field keyboardType="number-pad" onChangeText={setLocalPort} value={localPort} />
                  <Text style={styles.hint}>Use 0 to choose an available port automatically.</Text>
                </View>
                <PrimaryButton
                  loading={busy}
                  onPress={() => {
                    if (editingRule) {
                      void saveEditedRule();
                      return;
                    }
                    const request = buildRequest();
                    if (request) void requestStart(request, true);
                  }}
                >
                  {editingRule ? 'Save changes' : 'Start & save'}
                </PrimaryButton>
                {editingRule ? (
                  <Pressable onPress={resetForwardForm} style={styles.secondaryButton}>
                    <Text style={styles.secondaryText}>Cancel editing</Text>
                  </Pressable>
                ) : null}
              </Panel>
            ) : !pendingRequest ? (
              <Notice>Choose the ⇄ action beside a node login to create a new forward.</Notice>
            ) : null}

            <View style={styles.listSection}>
              <Text style={styles.listTitle}>Active · {active.length}</Text>
              {active.map(forward => (
                <Panel key={forward.id} style={styles.forwardCard}>
                  <View style={styles.forwardCopy}>
                    <View style={styles.statusRow}>
                      <View style={styles.statusDot} />
                      <Text numberOfLines={1} style={styles.forwardName}>{forward.name}</Text>
                    </View>
                    <Text style={styles.route}>
                      {forward.localHost}:{forward.localPort} → {forward.remoteHost}:{forward.remotePort}
                    </Text>
                    <Text style={styles.meta}>
                      {forward.login}@{forward.hostname} · {forward.activeConnections} clients
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`Stop ${forward.name}`}
                    accessibilityRole="button"
                    onPress={() => setStopTarget(forward)}
                    style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.stopText}>Stop</Text>
                  </Pressable>
                </Panel>
              ))}
              {!active.length ? <Text style={styles.empty}>No active port forwards.</Text> : null}
            </View>

            <View style={styles.listSection}>
              <Text style={styles.listTitle}>Saved · {rules.length}</Text>
              {rules.map(rule => {
                const running = active.some(forward =>
                  forward.serverId === rule.serverId
                  && forward.login === rule.login
                  && forward.remoteHost === rule.remoteHost
                  && forward.remotePort === rule.remotePort
                  && (rule.localPort === 0 || forward.localPort === rule.localPort)
                );
                return (
                  <Panel key={rule.id} style={[styles.forwardCard, styles.savedForwardCard]}>
                    <View style={styles.forwardCopy}>
                      <Text numberOfLines={1} style={styles.forwardName}>{rule.name}</Text>
                      <Text style={styles.route}>
                        127.0.0.1:{rule.localPort || 'auto'} → {rule.remoteHost}:{rule.remotePort}
                      </Text>
                      <Text style={styles.meta}>{rule.login}@{rule.hostname}</Text>
                    </View>
                    <View style={styles.ruleActions}>
                      <Pressable
                        accessibilityRole="button"
                        disabled={running || busy}
                        onPress={() => void requestStart(rule)}
                        style={({ pressed }) => [styles.startButton, running && styles.disabled, pressed && styles.pressed]}
                      >
                        <Text style={styles.startText}>{running ? 'Active' : 'Start'}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Edit saved forward ${rule.name}`}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => beginEditingRule(rule)}
                        style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}
                      >
                        <Text style={styles.editText}>Edit</Text>
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Delete saved forward ${rule.name}`}
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => setDeleteTarget(rule)}
                        style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}
                      >
                        <Text style={styles.deleteText}>×</Text>
                      </Pressable>
                    </View>
                  </Panel>
                );
              })}
              {!rules.length ? <Text style={styles.empty}>Saved forwards will appear here.</Text> : null}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <ThemedConfirmDialog
        busy={busy}
        confirmLabel="Remove saved forward"
        eyebrow="Remove saved profile"
        message={deleteTarget
          ? `This removes the saved settings for ${deleteTarget.name}. Any active listener keeps running until you stop it.`
          : ''}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void deleteRule()}
        title={deleteTarget ? `Remove ${deleteTarget.name}?` : 'Remove saved forward?'}
        visible={Boolean(deleteTarget)}
      />
      <ThemedConfirmDialog
        busy={busy}
        confirmLabel="Stop forward"
        eyebrow="Disconnect"
        message={stopTarget
          ? `This closes the listener on ${stopTarget.localHost}:${stopTarget.localPort} and all active connections through it.`
          : ''}
        onCancel={() => setStopTarget(null)}
        onConfirm={() => void stopForward()}
        title={stopTarget ? `Stop ${stopTarget.name}?` : 'Stop forward?'}
        visible={Boolean(stopTarget)}
      />
    </SafeAreaView>
  );
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.ink },
  flex: { flex: 1 },
  content: { alignItems: 'center', padding: space.lg, paddingBottom: space.xxl },
  page: { width: '100%', maxWidth: 820, gap: space.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  backButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  backText: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 32, lineHeight: 34 },
  headerCopy: { flex: 1 },
  eyebrow: { color: palette.signal, fontFamily: type.monoStrong, fontSize: 9, letterSpacing: 1.4 },
  title: { color: palette.porcelain, fontFamily: type.display, fontSize: 34, lineHeight: 38 },
  section: { gap: space.md },
  sectionTitle: { color: palette.porcelain, fontFamily: type.displayStrong, fontSize: 23 },
  supporting: { color: palette.mist, fontFamily: type.mono, fontSize: 10, lineHeight: 17 },
  authMethods: { flexDirection: 'row', gap: space.xs },
  authMethod: {
    flex: 1,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: palette.rule,
    borderWidth: 1,
    borderRadius: radius.sm,
  },
  authMethodActive: { borderColor: palette.copper, backgroundColor: palette.raised },
  authMethodText: { color: palette.quiet, fontFamily: type.monoMedium, fontSize: 9 },
  authMethodTextActive: { color: palette.copper },
  target: { color: palette.signal, fontFamily: type.monoMedium, fontSize: 10, marginTop: 3 },
  fieldPair: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  hostField: { flex: 1 },
  portField: { width: 126 },
  hint: { color: palette.quiet, fontFamily: type.mono, fontSize: 8, marginTop: space.xs },
  secondaryButton: { minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: palette.mist, fontFamily: type.monoMedium, fontSize: 10 },
  listSection: { gap: space.sm },
  listTitle: { color: palette.quiet, fontFamily: type.monoStrong, fontSize: 9, letterSpacing: 1.2, textTransform: 'uppercase' },
  forwardCard: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  savedForwardCard: { alignItems: 'stretch', flexDirection: 'column', gap: space.sm },
  forwardCopy: { flex: 1, minWidth: 0, gap: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.signal },
  forwardName: { flexShrink: 1, color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 12 },
  route: { color: palette.copper, fontFamily: type.mono, fontSize: 9 },
  meta: { color: palette.quiet, fontFamily: type.mono, fontSize: 8 },
  stopButton: { borderColor: palette.danger, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  stopText: { color: palette.danger, fontFamily: type.monoStrong, fontSize: 9 },
  ruleActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space.sm },
  startButton: { borderColor: palette.signal, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  startText: { color: palette.signal, fontFamily: type.monoStrong, fontSize: 9 },
  editButton: { minHeight: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xs },
  editText: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 9 },
  deleteButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  deleteText: { color: palette.quiet, fontFamily: type.monoStrong, fontSize: 18 },
  empty: { color: palette.quiet, fontFamily: type.mono, fontSize: 10, paddingVertical: space.sm },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.45 },
});
