import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Field,
  Notice,
  Panel,
  PrimaryButton,
} from '@/components/shell-ui';
import { ThemedConfirmDialog } from '@/components/themed-confirm-dialog';
import { palette, radius, space, type } from '@/constants/tokens';
import { getResponsiveLayout, responsiveLayout } from '@/lib/layout/responsive';
import {
  activateSavedProfile,
  signOutSavedProfile,
  withSavedProfile,
} from '@/lib/teleport/profile-session';
import {
  listSavedProfiles,
  loadActiveSavedProfile,
} from '@/lib/teleport/profile-store';
import {
  getTerminalWorkspaceManager,
  isActiveTerminalState,
} from '@/lib/terminal/session-manager';
import type { SavedTeleportProfile, TeleportServer } from '@/types/teleport';

export default function ServersScreen() {
  const router = useRouter();
  const { height, width } = useWindowDimensions();
  const layout = getResponsiveLayout(width, height);
  const [listWidth, setListWidth] = useState(0);
  const [savedProfile, setSavedProfile] = useState<SavedTeleportProfile | null>(null);
  const [profiles, setProfiles] = useState<SavedTeleportProfile[]>([]);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [servers, setServers] = useState<TeleportServer[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [workspace] = useState(getTerminalWorkspaceManager);
  const [terminalWorkspace, setTerminalWorkspace] = useState(workspace.getSnapshot);
  const activeProfileIdRef = useRef<string | null>(null);
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    activeProfileIdRef.current = savedProfile?.id ?? null;
  }, [savedProfile?.id]);

  useFocusEffect(useCallback(() => {
    if (!loadedOnceRef.current) return;
    let mounted = true;
    void loadActiveSavedProfile().then(active => {
      if (!mounted || active?.id === activeProfileIdRef.current) return;
      setLoading(true);
      setRefreshRequest(request => request + 1);
    });
    return () => {
      mounted = false;
    };
  }, []));

  useEffect(() => {
    const unsubscribe = workspace.subscribe(setTerminalWorkspace);
    return () => {
      unsubscribe();
    };
  }, [workspace]);

  useEffect(() => {
    let active = true;
    async function loadServers() {
      if (active) setError('');
      try {
        const [nextProfile, nextProfiles] = await Promise.all([
          loadActiveSavedProfile(),
          listSavedProfiles(),
        ]);
        if (!nextProfile) {
          router.replace('/');
          return;
        }
        const nextServers = await withSavedProfile(
          nextProfile.id,
          client => client.listServers()
        );
        if (!active) return;
        setSavedProfile(nextProfile);
        setProfiles(nextProfiles);
        setServers(Array.isArray(nextServers) ? nextServers : []);
      } catch (loadError) {
        if (isRejectedSession(loadError)) {
          const rejected = await loadActiveSavedProfile();
          if (rejected) {
            await workspace.disconnectProfile(rejected.id);
            await signOutSavedProfile(rejected.id);
          }
          if (active) {
            router.replace({
              pathname: '/',
              params: {
                mode: 'signin',
                profileId: rejected?.id,
                reason: 'session-expired',
              },
            });
          }
          return;
        }
        if (active) setError(messageFrom(loadError));
      } finally {
        if (active) {
          loadedOnceRef.current = true;
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    void loadServers();
    return () => {
      active = false;
    };
  }, [refreshRequest, router, workspace]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter(server =>
      [server.hostname, ...Object.values(server.labels ?? {})]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [query, servers]);

  const activeTabs = savedProfile
    ? terminalWorkspace.tabs.filter(tab =>
        tab.profileId === savedProfile.id && isActiveTerminalState(tab.state)
      )
    : [];
  const cardWidth = listWidth > 0
    ? Math.floor(
        (listWidth - responsiveLayout.nodeGap * (layout.nodeColumns - 1))
          / layout.nodeColumns
      )
    : undefined;

  function confirmSignOut() {
    if (!savedProfile) return;
    setSignOutDialogOpen(true);
  }

  async function signOutCurrentProfile() {
    if (!savedProfile) return;
    setError('');
    setSigningOut(true);
    try {
      await workspace.disconnectProfile(savedProfile.id);
      await signOutSavedProfile(savedProfile.id);
      setProfileMenuOpen(false);
      setSignOutDialogOpen(false);
      router.replace({
        pathname: '/',
        params: {
          mode: 'signin',
          profileId: savedProfile.id,
          reason: 'signed-out',
        },
      });
    } catch (profileError) {
      setError(messageFrom(profileError));
    } finally {
      setSigningOut(false);
    }
  }

  function openServer(server: TeleportServer, login: string, forceNew = false) {
    if (!savedProfile) return;
    const session = (!forceNew
      ? workspace.findSession(savedProfile.id, server.id, login)
      : undefined)
      ?? workspace.createSession(savedProfile.id, {
        serverId: server.id,
        hostname: server.hostname,
        login,
      });
    router.push({
      pathname: '/terminal/[serverId]',
      params: { serverId: session.tabId },
    });
  }

  async function switchProfile(profileId: string) {
    if (profileId === savedProfile?.id) {
      setProfileMenuOpen(false);
      return;
    }
    setError('');
    const target = profiles.find(profile => profile.id === profileId);
    if (target && !target.sessionSnapshot) {
      setProfileMenuOpen(false);
      router.replace({
        pathname: '/',
        params: { mode: 'signin', profileId },
      });
      return;
    }
    setLoading(true);
    try {
      await activateSavedProfile(profileId);
      setSavedProfile(await loadActiveSavedProfile());
      setProfiles(await listSavedProfiles());
      setServers([]);
      setQuery('');
      setProfileMenuOpen(false);
      setRefreshRequest(request => request + 1);
    } catch (profileError) {
      setError(messageFrom(profileError));
      setLoading(false);
    }
  }

  function refreshServers() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshRequest(request => request + 1);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          layout.compact && styles.contentCompact,
          layout.shortViewport && styles.contentShort,
        ]}
        refreshControl={(
          <RefreshControl
            colors={[palette.copper]}
            onRefresh={refreshServers}
            progressBackgroundColor={palette.raised}
            refreshing={refreshing}
            tintColor={palette.copper}
          />
        )}
      >
        <View style={styles.page}>
        <View style={styles.topline}>
          <Pressable
            accessibilityLabel="Switch Teleport profile"
            accessibilityRole="button"
            onPress={() => setProfileMenuOpen(open => !open)}
            style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
          >
            <View style={styles.liveDot} />
            <View style={styles.identityCopy}>
              <Text numberOfLines={1} style={styles.cluster}>
                {savedProfile?.name ?? 'Cluster'}
              </Text>
              <Text numberOfLines={1} style={styles.user}>
                {savedProfile?.profile.username ?? 'operator'}@{savedProfile?.profile.clusterName ?? 'cluster'}
              </Text>
            </View>
            <Text style={styles.profileChevron}>{profileMenuOpen ? '⌃' : '⌄'}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`Sign out of ${savedProfile?.name ?? 'Teleport profile'}`}
            accessibilityRole="button"
            onPress={confirmSignOut}
            hitSlop={10}
          >
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>

        {profileMenuOpen ? (
          <Panel style={styles.profileMenu}>
            <Text style={styles.profileMenuCaption}>Teleport profiles</Text>
            {profiles.map(profile => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: profile.id === savedProfile?.id }}
                key={profile.id}
                onPress={() => switchProfile(profile.id)}
                style={({ pressed }) => [
                  styles.profileChoice,
                  profile.id === savedProfile?.id && styles.profileChoiceActive,
                  pressed && styles.pressed,
                ]}
              >
                <View style={[
                  styles.profileChoiceDot,
                  profile.id === savedProfile?.id && styles.profileChoiceDotActive,
                ]} />
                <View style={styles.profileChoiceCopy}>
                  <Text numberOfLines={1} style={styles.profileChoiceName}>{profile.name}</Text>
                  <Text numberOfLines={1} style={styles.profileChoiceIdentity}>
                    {profile.profile.username}@{profile.profile.proxyAddress}
                    {!profile.sessionSnapshot ? ' · signed out' : ''}
                  </Text>
                </View>
                <Text style={styles.profileShellCount}>
                  {terminalWorkspace.tabs.filter(tab =>
                    tab.profileId === profile.id && isActiveTerminalState(tab.state)
                  ).length || ''}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/', params: { mode: 'add' } })}
              style={({ pressed }) => [styles.addProfile, pressed && styles.pressed]}
            >
              <Text style={styles.addProfileMark}>＋</Text>
              <Text style={styles.addProfileText}>Add Teleport profile</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/profiles' as Href)}
              style={({ pressed }) => [styles.manageProfiles, pressed && styles.pressed]}
            >
              <Text style={styles.manageProfilesText}>Manage saved profiles</Text>
            </Pressable>
          </Panel>
        ) : null}

        <Text style={[
          styles.title,
          layout.compact && styles.titleCompact,
          layout.wide && styles.titleWide,
          layout.shortViewport && styles.titleShort,
        ]}>
          Choose the node for login
        </Text>

        {savedProfile?.profile.proxyAddress === 'demo.telemob.invalid'
          && savedProfile.profile.username === 'play-review' ? (
            <Notice>Offline store-review demo active. No external proxy is connected.</Notice>
          ) : null}

        <Field
          accessibilityLabel="Filter servers"
          value={query}
          onChangeText={setQuery}
          placeholder="Filter by host, role, region…"
        />

        {error ? (
          <View style={styles.errorBlock}>
            <Notice tone="error">{error}</Notice>
            <PrimaryButton loading={refreshing} onPress={refreshServers}>
              Retry
            </PrimaryButton>
          </View>
        ) : null}
        {loading ? (
          <ActivityIndicator color={palette.copper} style={styles.loader} />
        ) : (
          <View style={[styles.serverList, layout.compact && styles.serverListCompact]}>
            <Text style={styles.count}>{filtered.length} nodes available</Text>
            <View
              onLayout={event => setListWidth(event.nativeEvent.layout.width)}
              style={styles.serverGrid}
            >
              {filtered.map(server => (
                <ServerCard
                  activeLogins={activeTabs
                    .filter(tab => tab.target.serverId === server.id)
                    .map(tab => tab.target.login)}
                  compact={layout.compact}
                  key={server.id}
                  server={server}
                  width={cardWidth}
                  onOpen={openServer}
                />
              ))}
            </View>
            {!filtered.length && (
              <Notice>No nodes match this filter.</Notice>
            )}
          </View>
        )}
        </View>
      </ScrollView>
      <ThemedConfirmDialog
        busy={signingOut}
        confirmLabel="Sign out"
        eyebrow="TELEPORT SESSION"
        message={activeTabs.length
          ? `This disconnects ${activeTabs.length} active terminal${activeTabs.length === 1 ? '' : 's'} and clears the saved login. Connection settings remain on this device.`
          : 'This clears the saved login. Connection settings remain on this device for an easier sign-in next time.'}
        onCancel={() => setSignOutDialogOpen(false)}
        onConfirm={() => void signOutCurrentProfile()}
        title={savedProfile ? `Sign out of ${savedProfile.name}?` : 'Sign out?'}
        tone="accent"
        visible={signOutDialogOpen && Boolean(savedProfile)}
      />
    </SafeAreaView>
  );
}

function ServerCard({
  activeLogins,
  compact,
  server,
  width,
  onOpen,
}: {
  activeLogins: string[];
  compact: boolean;
  server: TeleportServer;
  width?: number;
  onOpen: (server: TeleportServer, login: string, forceNew?: boolean) => void;
}) {
  return (
    <Panel style={[
      styles.serverCard,
      compact && styles.serverCardCompact,
      activeLogins.length > 0 && styles.serverCardActive,
      width ? { width } : styles.serverCardFull,
    ]}>
      <View style={styles.serverHeader}>
        <View style={styles.hostBlock}>
          <View
            style={[
              styles.statusDot,
              server.status !== 'online' && styles.statusUnknown,
            ]}
          />
          <View style={styles.hostDetails}>
            <Text numberOfLines={2} style={styles.hostname}>{server.hostname}</Text>
            <View style={styles.hostMeta}>
              <Text numberOfLines={1} style={styles.address}>{server.address}</Text>
              {activeLogins.length ? (
                <View style={styles.activeBadge}>
                  <View style={styles.activeBadgeDot} />
                  <Text numberOfLines={1} style={styles.activeBadgeText}>
                    {activeLogins.length === 1
                      ? `${activeLogins[0]} session active`
                      : `${activeLogins.length} sessions active`}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
        <Text style={styles.arrow}>↗</Text>
      </View>

      <View style={styles.labels}>
        {Object.entries(server.labels ?? {}).map(([key, value]) => (
          <Text key={key} style={styles.label}>
            {key}:{value}
          </Text>
        ))}
      </View>

      <View style={styles.loginRow}>
        <Text style={styles.loginCaption}>Login as</Text>
        <View style={styles.loginChoices}>
          {(server.logins ?? []).map(login => {
            const activeCount = activeLogins.filter(active => active === login).length;
            return (
              <View key={login} style={styles.loginAction}>
                <Pressable
                  accessibilityLabel={activeCount ? `Open active ${login} session` : login}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeCount > 0 }}
                  onPress={() => onOpen(server, login)}
                  style={({ pressed }) => [
                    styles.loginButton,
                    activeCount > 0 && styles.loginButtonActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.loginText, activeCount > 0 && styles.loginTextActive]}>
                    {login}{activeCount > 1 ? ` · ${activeCount}` : ''}
                  </Text>
                </Pressable>
                {activeCount ? (
                  <Pressable
                    accessibilityLabel={`Open another ${login} session on ${server.hostname}`}
                    accessibilityRole="button"
                    onPress={() => onOpen(server, login, true)}
                    style={({ pressed }) => [styles.newShellButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.newShellText}>＋</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {!server.logins?.length ? (
            <Text style={styles.noLogins}>No permitted SSH logins</Text>
          ) : null}
        </View>
      </View>
    </Panel>
  );
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : 'Could not load servers.';
}

function isRejectedSession(error: unknown) {
  return /\bHTTP 401\b|Teleport login has expired|saved (?:Teleport|development) login (?:has expired|is incomplete)|decode saved Teleport login/i.test(
    messageFrom(error)
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.ink },
  content: { alignItems: 'center', padding: space.lg, paddingBottom: space.xxl },
  contentCompact: { padding: space.md, paddingBottom: space.xl },
  contentShort: { paddingVertical: space.md },
  page: { width: '100%', maxWidth: responsiveLayout.contentMaxWidth, gap: space.lg },
  topline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  identity: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  identityCopy: { minWidth: 0, flex: 1 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.signal },
  cluster: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 12 },
  user: { color: palette.quiet, fontFamily: type.mono, fontSize: 9, marginTop: 2 },
  profileChevron: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 13, paddingHorizontal: space.sm },
  signOut: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 11 },
  profileMenu: { gap: space.sm, padding: space.sm },
  profileMenuCaption: { color: palette.quiet, fontFamily: type.monoMedium, fontSize: 8, letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: space.xs },
  profileChoice: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderColor: 'transparent', borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.sm },
  profileChoiceActive: { borderColor: palette.signal, backgroundColor: palette.raised },
  profileChoiceDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.quiet },
  profileChoiceDotActive: { backgroundColor: palette.signal },
  profileChoiceCopy: { flex: 1, minWidth: 0 },
  profileChoiceName: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 11 },
  profileChoiceIdentity: { color: palette.quiet, fontFamily: type.mono, fontSize: 8, marginTop: 2 },
  profileShellCount: { minWidth: 18, color: palette.signal, fontFamily: type.monoStrong, fontSize: 10, textAlign: 'center' },
  addProfile: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderTopColor: palette.rule, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.sm, paddingTop: space.sm },
  addProfileMark: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 18 },
  addProfileText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 10 },
  manageProfiles: { minHeight: 38, alignItems: 'center', justifyContent: 'center', borderTopColor: palette.rule, borderTopWidth: StyleSheet.hairlineWidth },
  manageProfilesText: { color: palette.mist, fontFamily: type.monoMedium, fontSize: 9 },
  title: { color: palette.porcelain, fontFamily: type.display, fontSize: 34, lineHeight: 38, letterSpacing: -0.6 },
  titleCompact: { fontSize: 30, lineHeight: 34 },
  titleWide: { fontSize: 42, lineHeight: 46 },
  titleShort: { fontSize: 30, lineHeight: 33 },
  loader: { marginVertical: space.xl },
  errorBlock: { gap: space.sm },
  serverList: { gap: space.md },
  serverListCompact: { gap: 12 },
  serverGrid: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: responsiveLayout.nodeGap, alignItems: 'flex-start' },
  count: { color: palette.quiet, fontFamily: type.mono, fontSize: 10, letterSpacing: 0.7, textTransform: 'uppercase' },
  serverCard: { gap: space.md },
  serverCardFull: { width: '100%' },
  serverCardCompact: { gap: 14, padding: 14 },
  serverCardActive: { borderColor: palette.signal },
  serverHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  hostBlock: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  hostDetails: { flex: 1, minWidth: 0 },
  hostMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs, marginTop: 3 },
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.signal, marginTop: 6 },
  statusUnknown: { backgroundColor: palette.warning },
  hostname: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 15 },
  address: { flexShrink: 1, color: palette.quiet, fontFamily: type.mono, fontSize: 10 },
  activeBadge: { maxWidth: '100%', flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.pill, backgroundColor: palette.raised, paddingHorizontal: space.sm, paddingVertical: 5 },
  activeBadgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.signal },
  activeBadgeText: { flexShrink: 1, color: palette.signal, fontFamily: type.monoMedium, fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  arrow: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 20, lineHeight: 22 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  label: { color: palette.mist, backgroundColor: palette.raised, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 5, fontFamily: type.mono, fontSize: 9 },
  loginRow: { borderTopColor: palette.rule, borderTopWidth: 1, paddingTop: space.md, gap: space.sm },
  loginCaption: { color: palette.quiet, fontFamily: type.mono, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.8 },
  loginChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  loginAction: { flexDirection: 'row', alignItems: 'stretch', gap: space.sm },
  newShellButton: {
    minWidth: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.signal,
    borderRadius: radius.sm,
    backgroundColor: palette.raised,
  },
  newShellText: { color: palette.signal, fontFamily: type.monoMedium, fontSize: 13 },
  loginButton: { borderColor: palette.copperMuted, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  loginButtonActive: { borderColor: palette.signal, backgroundColor: palette.raised },
  loginText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 11 },
  loginTextActive: { color: palette.signal },
  noLogins: { color: palette.warning, fontFamily: type.mono, fontSize: 10 },
  pressed: { opacity: 0.65 },
});
