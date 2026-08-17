import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Field, Notice, Panel } from '@/components/shell-ui';
import { ThemedConfirmDialog } from '@/components/themed-confirm-dialog';
import { palette, radius, space, type } from '@/constants/tokens';
import {
  activateSavedProfile,
  clearNativeAuthentication,
  forgetNativeProfile,
  signOutSavedProfile,
} from '@/lib/teleport/profile-session';
import {
  listSavedProfiles,
  loadActiveSavedProfile,
  removeSavedProfile,
  renameSavedProfile,
} from '@/lib/teleport/profile-store';
import {
  getTerminalWorkspaceManager,
  isActiveTerminalState,
} from '@/lib/terminal/session-manager';
import type { SavedTeleportProfile } from '@/types/teleport';

export default function ProfilesScreen() {
  const router = useRouter();
  const [workspace] = useState(getTerminalWorkspaceManager);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(workspace.getSnapshot);
  const [profiles, setProfiles] = useState<SavedTeleportProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pendingForgetProfile, setPendingForgetProfile] = useState<SavedTeleportProfile | null>(null);
  const [forgettingProfileId, setForgettingProfileId] = useState<string | null>(null);
  const [pendingSignOutProfile, setPendingSignOutProfile] = useState<SavedTeleportProfile | null>(null);
  const [signingOutProfileId, setSigningOutProfileId] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = workspace.subscribe(setWorkspaceSnapshot);
    return () => {
      unsubscribe();
    };
  }, [workspace]);

  useEffect(() => {
    void reloadProfiles();
  }, []);

  async function reloadProfiles() {
    const [saved, active] = await Promise.all([
      listSavedProfiles(),
      loadActiveSavedProfile(),
    ]);
    setProfiles(saved);
    setActiveProfileId(active?.id ?? null);
  }

  async function selectProfile(profileId: string) {
    setError('');
    const selected = profiles.find(profile => profile.id === profileId);
    if (selected && !selected.sessionSnapshot) {
      router.replace({ pathname: '/', params: { mode: 'signin', profileId } });
      return;
    }
    try {
      await activateSavedProfile(profileId);
      setActiveProfileId(profileId);
      router.dismissTo('/servers');
    } catch (profileError) {
      setError(messageFrom(profileError));
    }
  }

  async function renameProfile(profileId: string, name: string) {
    setError('');
    try {
      await renameSavedProfile(profileId, name);
      await reloadProfiles();
    } catch (profileError) {
      setError(messageFrom(profileError));
    }
  }

  function confirmForget(profile: SavedTeleportProfile) {
    setPendingForgetProfile(profile);
  }

  async function forgetProfile(profileId: string) {
    setError('');
    setForgettingProfileId(profileId);
    try {
      await workspace.disconnectProfile(profileId);
      const store = await removeSavedProfile(profileId);
      forgetNativeProfile(profileId);
      if (!store.activeProfileId) {
        await clearNativeAuthentication();
        router.replace('/');
        return;
      }
      if (profileId === activeProfileId) {
        const next = await loadActiveSavedProfile();
        if (!next?.sessionSnapshot) {
          router.replace({
            pathname: '/',
            params: { mode: 'signin', profileId: next?.id },
          });
          return;
        }
        await activateSavedProfile(next.id);
      }
      await reloadProfiles();
      setPendingForgetProfile(null);
    } catch (profileError) {
      setError(messageFrom(profileError));
    } finally {
      setForgettingProfileId(null);
    }
  }

  async function signOutProfile(profile: SavedTeleportProfile) {
    setError('');
    setSigningOutProfileId(profile.id);
    try {
      await workspace.disconnectProfile(profile.id);
      await signOutSavedProfile(profile.id);
      setPendingSignOutProfile(null);
      if (profile.id === activeProfileId) {
        router.replace({
          pathname: '/',
          params: { mode: 'signin', profileId: profile.id, reason: 'signed-out' },
        });
        return;
      }
      await reloadProfiles();
    } catch (profileError) {
      setError(messageFrom(profileError));
    } finally {
      setSigningOutProfileId(null);
    }
  }

  function countSessions(profileId: string) {
    return workspaceSnapshot.tabs.filter(tab =>
      tab.profileId === profileId && isActiveTerminalState(tab.state)
    ).length;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.page}>
          <View style={styles.header}>
            <Pressable
              accessibilityLabel="Back"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.back()}
            >
              <Text style={styles.back}>‹</Text>
            </Pressable>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Teleport profiles</Text>
              <Text style={styles.subtitle}>Saved identities on this device</Text>
            </View>
          </View>

          {error ? <Notice tone="error">{error}</Notice> : null}

          <View style={styles.profileList}>
            {profiles.map(profile => (
              <ProfileEditor
                active={profile.id === activeProfileId}
                key={`${profile.id}:${profile.name}`}
                profile={profile}
                sessionCount={countSessions(profile.id)}
                onForget={() => confirmForget(profile)}
                onRename={name => renameProfile(profile.id, name)}
                onSignOut={() => setPendingSignOutProfile(profile)}
                onUse={() => selectProfile(profile.id)}
              />
            ))}
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/', params: { mode: 'add' } })}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
          >
            <Text style={styles.addMark}>＋</Text>
            <View>
              <Text style={styles.addTitle}>Add Teleport profile</Text>
              <Text style={styles.addDetail}>Connect another proxy or identity</Text>
            </View>
          </Pressable>
        </View>
      </ScrollView>
      <ThemedConfirmDialog
        busy={signingOutProfileId === pendingSignOutProfile?.id}
        confirmLabel="Sign out"
        eyebrow="TELEPORT SESSION"
        message={pendingSignOutProfile
          ? countSessions(pendingSignOutProfile.id)
            ? `This disconnects ${countSessions(pendingSignOutProfile.id)} active terminal${countSessions(pendingSignOutProfile.id) === 1 ? '' : 's'} and clears the saved login. Connection settings remain on this device.`
            : 'This clears the saved login. Connection settings remain on this device for an easier sign-in next time.'
          : ''}
        onCancel={() => setPendingSignOutProfile(null)}
        onConfirm={() => {
          if (pendingSignOutProfile) void signOutProfile(pendingSignOutProfile);
        }}
        title={pendingSignOutProfile ? `Sign out of ${pendingSignOutProfile.name}?` : 'Sign out?'}
        tone="accent"
        visible={Boolean(pendingSignOutProfile)}
      />
      <ThemedConfirmDialog
        busy={forgettingProfileId === pendingForgetProfile?.id}
        confirmLabel="Forget profile"
        eyebrow="SAVED IDENTITY"
        message={pendingForgetProfile
          ? countSessions(pendingForgetProfile.id)
            ? `This disconnects ${countSessions(pendingForgetProfile.id)} active terminal${countSessions(pendingForgetProfile.id) === 1 ? '' : 's'} and removes the saved login from this device.`
            : 'This removes the saved login from this device.'
          : ''}
        onCancel={() => setPendingForgetProfile(null)}
        onConfirm={() => {
          if (pendingForgetProfile) void forgetProfile(pendingForgetProfile.id);
        }}
        title={pendingForgetProfile ? `Forget ${pendingForgetProfile.name}?` : 'Forget profile?'}
        visible={Boolean(pendingForgetProfile)}
      />
    </SafeAreaView>
  );
}

function ProfileEditor({
  active,
  profile,
  sessionCount,
  onForget,
  onRename,
  onSignOut,
  onUse,
}: {
  active: boolean;
  profile: SavedTeleportProfile;
  sessionCount: number;
  onForget: () => void;
  onRename: (name: string) => void;
  onSignOut: () => void;
  onUse: () => void;
}) {
  const [name, setName] = useState(profile.name);

  return (
    <Panel style={[styles.profileCard, active && styles.profileCardActive]}>
      <View style={styles.profileTopline}>
        <View style={[
          styles.statusDot,
          active && profile.sessionSnapshot && styles.statusDotActive,
        ]} />
        <View style={styles.profileIdentity}>
          <Text numberOfLines={1} style={styles.clusterName}>{profile.profile.clusterName}</Text>
          <Text numberOfLines={1} style={styles.identityDetail}>
            {profile.profile.username}@{profile.profile.proxyAddress}
          </Text>
        </View>
        {!profile.sessionSnapshot ? (
          <Text style={styles.signedOutLabel}>SIGNED OUT</Text>
        ) : active ? (
          <Text style={styles.activeLabel}>ACTIVE</Text>
        ) : null}
      </View>

      <View style={styles.nameRow}>
        <Field
          accessibilityLabel={`Name for ${profile.profile.clusterName}`}
          onChangeText={setName}
          placeholder="Profile name"
          style={styles.nameField}
          value={name}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!name.trim() || name.trim() === profile.name}
          onPress={() => onRename(name)}
          style={({ pressed }) => [
            styles.saveButton,
            (!name.trim() || name.trim() === profile.name) && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.saveText}>Save name</Text>
        </Pressable>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.meta}>{profile.authMethod === 'passkey' ? 'Browser passkey' : 'TOTP'}</Text>
        <Text style={[styles.meta, profile.insecure && styles.insecureMeta]}>
          {profile.insecure ? 'Insecure TLS' : 'Verified TLS'}
        </Text>
        {sessionCount ? <Text style={styles.sessionMeta}>{sessionCount} active</Text> : null}
      </View>

      <View style={styles.actions}>
        {!active || !profile.sessionSnapshot ? (
          <Pressable
            accessibilityRole="button"
            onPress={onUse}
            style={({ pressed }) => [styles.useButton, pressed && styles.pressed]}
          >
            <Text style={styles.useText}>
              {profile.sessionSnapshot ? 'Use profile' : 'Sign in'}
            </Text>
          </Pressable>
        ) : null}
        {profile.sessionSnapshot ? (
          <Pressable
            accessibilityRole="button"
            onPress={onSignOut}
            style={({ pressed }) => [styles.signOutButton, pressed && styles.pressed]}
          >
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={onForget}
          style={({ pressed }) => [styles.forgetButton, pressed && styles.pressed]}
        >
          <Text style={styles.forgetText}>Forget profile</Text>
        </Pressable>
      </View>
    </Panel>
  );
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : 'Could not update profiles.';
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.ink },
  content: { alignItems: 'center', padding: space.lg, paddingBottom: space.xxl },
  page: { width: '100%', maxWidth: 760, gap: space.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  back: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 34, lineHeight: 36 },
  headerCopy: { flex: 1 },
  title: { color: palette.porcelain, fontFamily: type.display, fontSize: 34, lineHeight: 38 },
  subtitle: { color: palette.quiet, fontFamily: type.mono, fontSize: 9, marginTop: 2 },
  profileList: { gap: space.md },
  profileCard: { gap: space.md },
  profileCardActive: { borderColor: palette.signal },
  profileTopline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.quiet },
  statusDotActive: { backgroundColor: palette.signal },
  profileIdentity: { flex: 1, minWidth: 0 },
  clusterName: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 13 },
  identityDetail: { color: palette.quiet, fontFamily: type.mono, fontSize: 9, marginTop: 3 },
  activeLabel: { color: palette.signal, fontFamily: type.monoStrong, fontSize: 8, letterSpacing: 1 },
  signedOutLabel: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 8, letterSpacing: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'stretch', gap: space.sm },
  nameField: { flex: 1 },
  saveButton: { minWidth: 96, alignItems: 'center', justifyContent: 'center', borderColor: palette.copperMuted, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.sm },
  saveText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 9 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  meta: { color: palette.mist, backgroundColor: palette.raised, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 5, fontFamily: type.mono, fontSize: 8 },
  insecureMeta: { color: palette.warning },
  sessionMeta: { color: palette.signal, backgroundColor: palette.raised, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 5, fontFamily: type.monoMedium, fontSize: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, borderTopColor: palette.rule, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md },
  useButton: { minHeight: 36, justifyContent: 'center', borderColor: palette.signal, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md },
  useText: { color: palette.signal, fontFamily: type.monoMedium, fontSize: 9 },
  signOutButton: { minHeight: 36, justifyContent: 'center', borderColor: palette.copperMuted, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md },
  signOutText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 9 },
  forgetButton: { minHeight: 36, justifyContent: 'center', borderColor: palette.danger, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md },
  forgetText: { color: palette.danger, fontFamily: type.monoMedium, fontSize: 9 },
  addButton: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: space.md, borderColor: palette.copperMuted, borderWidth: 1, borderRadius: radius.md, backgroundColor: palette.panel, padding: space.md },
  addMark: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 24 },
  addTitle: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 11 },
  addDetail: { color: palette.quiet, fontFamily: type.mono, fontSize: 8, marginTop: 3 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
