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
import { getConnectivitySnapshot } from '@/lib/network/connectivity';
import {
  classifyConnectionError,
  rawErrorMessage,
  type ConnectionIssue,
} from '@/lib/network/recovery';
import {
  runWithConnectionRetry,
  type ConnectionRetryProgress,
} from '@/lib/network/retry';
import { useConnectivity } from '@/lib/network/use-connectivity';
import {
  createDefaultNodePreferences,
  loadProfileNodePreferences,
  saveNodeViewPreferences,
  setNodeFavorite,
  type NodeSortMode,
  type NodeViewPreferences,
  type ProfileNodePreferences,
  type RecentNodePreference,
} from '@/lib/teleport/node-preferences';
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
  const connectivity = useConnectivity();
  const [listWidth, setListWidth] = useState(0);
  const [savedProfile, setSavedProfile] = useState<SavedTeleportProfile | null>(null);
  const [profiles, setProfiles] = useState<SavedTeleportProfile[]>([]);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [servers, setServers] = useState<TeleportServer[]>([]);
  const [nodePreferences, setNodePreferences] = useState(createDefaultNodePreferences);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const [connectionIssue, setConnectionIssue] = useState<ConnectionIssue | null>(null);
  const [retryProgress, setRetryProgress] = useState<ConnectionRetryProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [workspace] = useState(getTerminalWorkspaceManager);
  const [terminalWorkspace, setTerminalWorkspace] = useState(workspace.getSnapshot);
  const activeProfileIdRef = useRef<string | null>(null);
  const loadedOnceRef = useRef(false);
  const failedNetworkGenerationRef = useRef<number | null>(null);
  const observedNetworkGenerationRef = useRef(connectivity.generation);

  useEffect(() => {
    activeProfileIdRef.current = savedProfile?.id ?? null;
  }, [savedProfile?.id]);

  useFocusEffect(useCallback(() => {
    if (!loadedOnceRef.current) return;
    let mounted = true;
    void loadActiveSavedProfile().then(async active => {
      if (!mounted) return;
      if (active?.id === activeProfileIdRef.current) {
        if (active) {
          const preferences = await loadProfileNodePreferences(active.id);
          if (mounted && active.id === activeProfileIdRef.current) {
            setNodePreferences(preferences);
          }
        }
        return;
      }
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
    const previous = observedNetworkGenerationRef.current;
    observedNetworkGenerationRef.current = connectivity.generation;
    if (
      previous === connectivity.generation
      || !loadedOnceRef.current
      || !connectivity.available
      || failedNetworkGenerationRef.current === null
      || failedNetworkGenerationRef.current === connectivity.generation
    ) {
      return;
    }
    failedNetworkGenerationRef.current = null;
    setRefreshing(true);
    setRefreshRequest(request => request + 1);
  }, [connectivity.available, connectivity.generation]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function loadServers() {
      if (active) {
        setError('');
        setConnectionIssue(null);
        setRetryProgress(null);
      }
      try {
        const [nextProfile, nextProfiles] = await Promise.all([
          loadActiveSavedProfile(),
          listSavedProfiles(),
        ]);
        if (!nextProfile) {
          router.replace('/');
          return;
        }
        if (active) {
          setSavedProfile(nextProfile);
          setProfiles(nextProfiles);
        }
        const nextNodePreferences = await loadProfileNodePreferences(nextProfile.id);
        const nextServers = await runWithConnectionRetry(
          () => withSavedProfile(nextProfile.id, client => client.listServers()),
          {
            maxAttempts: 4,
            signal: controller.signal,
            onRetry: progress => {
              if (!active) return;
              setRetryProgress(progress);
              setConnectionIssue(progress.issue);
            },
          }
        );
        if (!active) return;
        setSavedProfile(nextProfile);
        setProfiles(nextProfiles);
        setServers(Array.isArray(nextServers) ? nextServers : []);
        setNodePreferences(nextNodePreferences);
        setConnectionIssue(null);
        setRetryProgress(null);
        failedNetworkGenerationRef.current = null;
      } catch (loadError) {
        if (controller.signal.aborted) return;
        const issue = classifyConnectionError(loadError, getConnectivitySnapshot());
        if (issue.requiresAuthentication) {
          const rejected = await loadActiveSavedProfile();
          if (rejected) {
            await workspace.disconnectProfile(rejected.id);
            const signedOut = await signOutSavedProfile(rejected.id);
            if (active) setSavedProfile(signedOut);
          }
          if (active) {
            setConnectionIssue(issue);
            setRetryProgress(null);
            setError(issue.message);
          }
          return;
        }
        if (active) {
          setConnectionIssue(issue);
          setRetryProgress(null);
          setError(issue.message);
          failedNetworkGenerationRef.current = getConnectivitySnapshot().generation;
        }
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
      controller.abort();
    };
  }, [refreshRequest, router, workspace]);

  const filtered = useMemo(() => filterAndSortServers(
    servers,
    savedProfile?.profile.clusterName ?? '',
    nodePreferences
  ), [nodePreferences, savedProfile?.profile.clusterName, servers]);

  const activeTabs = savedProfile
    ? terminalWorkspace.tabs.filter(tab =>
        tab.profileId === savedProfile.id && isActiveTerminalState(tab.state)
      )
    : [];
  const favoriteServerIds = new Set(nodePreferences.favoriteServerIds);
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

  function openForward(server: TeleportServer, login: string) {
    if (!savedProfile) return;
    router.push({
      pathname: '/forwards',
      params: {
        serverId: server.id,
        hostname: server.hostname,
        login,
        clusterName: server.clusterName ?? savedProfile.profile.clusterName,
      },
    } as unknown as Href);
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
      setNodePreferences(createDefaultNodePreferences());
      setSortMenuOpen(false);
      setProfileMenuOpen(false);
      setRefreshRequest(request => request + 1);
    } catch (profileError) {
      setError(messageFrom(profileError));
      setLoading(false);
    }
  }

  function refreshServers() {
    if (connectionIssue?.requiresAuthentication) {
      router.dismissTo({
        pathname: '/',
        params: {
          mode: 'signin',
          profileId: savedProfile?.id,
          reason: 'session-expired',
        },
      });
      return;
    }
    if (refreshing) return;
    setRefreshing(true);
    setRefreshRequest(request => request + 1);
  }

  function updateViewPreferences(patch: Partial<NodeViewPreferences>) {
    if (!savedProfile) return;
    const view = { ...nodePreferences.view, ...patch };
    setNodePreferences(current => ({ ...current, view }));
    void saveNodeViewPreferences(savedProfile.id, view).catch(preferenceError => {
      setError(messageFrom(preferenceError));
    });
  }

  function clearNodeFilters() {
    updateViewPreferences({
      query: '',
      favoritesOnly: false,
      recentOnly: false,
      onlineOnly: false,
    });
  }

  function toggleFavorite(serverId: string) {
    if (!savedProfile) return;
    const favorite = !favoriteServerIds.has(serverId);
    setNodePreferences(current => ({
      ...current,
      favoriteServerIds: favorite
        ? [...new Set([...current.favoriteServerIds, serverId])]
        : current.favoriteServerIds.filter(id => id !== serverId),
    }));
    void setNodeFavorite(savedProfile.id, serverId, favorite).catch(preferenceError => {
      setError(messageFrom(preferenceError));
      void loadProfileNodePreferences(savedProfile.id).then(setNodePreferences);
    });
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
          <View style={styles.topActions}>
            <Pressable
              accessibilityLabel="Manage port forwards"
              accessibilityRole="button"
              onPress={() => router.push('/forwards' as Href)}
              hitSlop={8}
            >
              <Text style={styles.forwardsLink}>⇄ Port forwards</Text>
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

        {!connectivity.available ? (
          <Notice tone="warning">
            Device offline. Node discovery will continue when a network connection returns.
          </Notice>
        ) : retryProgress ? (
          <Notice tone="warning">
            {retryProgress.issue.message}{' '}
            {retryProgress.delayMs === null
              ? 'Waiting for a network connection.'
              : `Retry ${retryProgress.nextAttempt} of 4 in ${formatRetryDelay(retryProgress.delayMs)}.`}
          </Notice>
        ) : null}

        <Field
          accessibilityLabel="Filter servers"
          value={nodePreferences.view.query}
          onChangeText={query => updateViewPreferences({ query })}
          placeholder="Filter hostname, label, cluster, status…"
        />

        <View style={styles.discoveryTools}>
          <ScrollView
            contentContainerStyle={styles.filterRail}
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
          >
            <FilterChip
              active={nodePreferences.view.favoritesOnly}
              label="★ Favorites"
              onPress={() => updateViewPreferences({
                favoritesOnly: !nodePreferences.view.favoritesOnly,
              })}
            />
            <FilterChip
              active={nodePreferences.view.recentOnly}
              label="↺ Recent"
              onPress={() => updateViewPreferences({
                recentOnly: !nodePreferences.view.recentOnly,
              })}
            />
            <FilterChip
              active={nodePreferences.view.onlineOnly}
              label="● Online"
              onPress={() => updateViewPreferences({
                onlineOnly: !nodePreferences.view.onlineOnly,
              })}
            />
            <Pressable
              accessibilityLabel={`Sort nodes by ${sortModeLabel(nodePreferences.view.sortMode)}`}
              accessibilityRole="button"
              onPress={() => setSortMenuOpen(open => !open)}
              style={({ pressed }) => [
                styles.sortButton,
                sortMenuOpen && styles.sortButtonOpen,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.sortCaption}>SORT</Text>
              <Text style={styles.sortValue}>{sortModeLabel(nodePreferences.view.sortMode)}</Text>
              <Text style={styles.sortChevron}>{sortMenuOpen ? '⌃' : '⌄'}</Text>
            </Pressable>
          </ScrollView>
          {sortMenuOpen ? (
            <Panel style={styles.sortMenu}>
              {nodeSortOptions.map(option => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: nodePreferences.view.sortMode === option.value }}
                  key={option.value}
                  onPress={() => {
                    updateViewPreferences({ sortMode: option.value });
                    setSortMenuOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.sortChoice,
                    nodePreferences.view.sortMode === option.value && styles.sortChoiceActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={[
                    styles.sortChoiceDot,
                    nodePreferences.view.sortMode === option.value && styles.sortChoiceDotActive,
                  ]} />
                  <View style={styles.sortChoiceCopy}>
                    <Text style={styles.sortChoiceLabel}>{option.label}</Text>
                    <Text style={styles.sortChoiceDetail}>{option.detail}</Text>
                  </View>
                </Pressable>
              ))}
            </Panel>
          ) : null}
        </View>

        {error ? (
          <View style={styles.errorBlock}>
            <Notice tone="error">{error}</Notice>
            <PrimaryButton loading={refreshing} onPress={refreshServers}>
              {connectionIssue?.requiresAuthentication ? 'Sign in again' : 'Retry'}
            </PrimaryButton>
          </View>
        ) : null}
        {loading ? (
          <ActivityIndicator color={palette.copper} style={styles.loader} />
        ) : (
          <View style={[styles.serverList, layout.compact && styles.serverListCompact]}>
            <Text style={styles.count}>
              {filtered.length === servers.length
                ? `${filtered.length} nodes available`
                : `${filtered.length} of ${servers.length} nodes`}
              {' · '}{sortModeLabel(nodePreferences.view.sortMode)} order
            </Text>
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
                  favorite={favoriteServerIds.has(server.id)}
                  key={server.id}
                  recent={nodePreferences.recentConnections[server.id]}
                  server={server}
                  width={cardWidth}
                  onToggleFavorite={() => toggleFavorite(server.id)}
                  onOpen={openServer}
                  onOpenForward={openForward}
                />
              ))}
            </View>
            {!filtered.length && (
              <View style={styles.emptyResults}>
                <Notice>No nodes match the current filters.</Notice>
                <Pressable
                  accessibilityRole="button"
                  onPress={clearNodeFilters}
                  style={({ pressed }) => [styles.clearFilters, pressed && styles.pressed]}
                >
                  <Text style={styles.clearFiltersText}>Clear filters</Text>
                </Pressable>
              </View>
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
  favorite,
  recent,
  server,
  width,
  onToggleFavorite,
  onOpen,
  onOpenForward,
}: {
  activeLogins: string[];
  compact: boolean;
  favorite: boolean;
  recent?: RecentNodePreference;
  server: TeleportServer;
  width?: number;
  onToggleFavorite: () => void;
  onOpen: (server: TeleportServer, login: string, forceNew?: boolean) => void;
  onOpenForward: (server: TeleportServer, login: string) => void;
}) {
  const preferredLogin = recent && server.logins?.includes(recent.preferredLogin)
    ? recent.preferredLogin
    : undefined;
  const orderedLogins = preferredLogin
    ? [preferredLogin, ...(server.logins ?? []).filter(login => login !== preferredLogin)]
    : server.logins ?? [];

  return (
    <Panel style={[
      styles.serverCard,
      compact && styles.serverCardCompact,
      favorite && styles.serverCardFavorite,
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
              {recent ? (
                <View style={styles.recentBadge}>
                  <Text numberOfLines={1} style={styles.recentBadgeText}>
                    ↺ {formatRelativeTime(recent.lastConnectedAt)}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
        <View style={styles.serverHeaderActions}>
          <Pressable
            accessibilityLabel={favorite
              ? `Remove ${server.hostname} from favorites`
              : `Add ${server.hostname} to favorites`}
            accessibilityRole="button"
            accessibilityState={{ selected: favorite }}
            hitSlop={8}
            onPress={onToggleFavorite}
            style={({ pressed }) => [styles.favoriteButton, pressed && styles.pressed]}
          >
            <Text style={[styles.favoriteIcon, favorite && styles.favoriteIconActive]}>
              {favorite ? '★' : '☆'}
            </Text>
          </Pressable>
          <Text style={styles.arrow}>↗</Text>
        </View>
      </View>

      <View style={styles.labels}>
        {Object.entries(server.labels ?? {}).map(([key, value]) => (
          <Text key={key} style={styles.label}>
            {key}:{value}
          </Text>
        ))}
      </View>

      <View style={styles.loginRow}>
        <View style={styles.loginCaptionRow}>
          <Text style={styles.loginCaption}>Login as</Text>
          {preferredLogin ? (
            <Text style={styles.preferredLogin}>preferred · {preferredLogin}</Text>
          ) : null}
        </View>
        <View style={styles.loginChoices}>
          {orderedLogins.map(login => {
            const activeCount = activeLogins.filter(active => active === login).length;
            const preferred = login === preferredLogin;
            return (
              <View key={login} style={styles.loginAction}>
                <Pressable
                  accessibilityLabel={activeCount ? `Open active ${login} session` : login}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeCount > 0 }}
                  onPress={() => onOpen(server, login)}
                  style={({ pressed }) => [
                    styles.loginButton,
                    preferred && styles.loginButtonPreferred,
                    activeCount > 0 && styles.loginButtonActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[
                    styles.loginText,
                    preferred && styles.loginTextPreferred,
                    activeCount > 0 && styles.loginTextActive,
                  ]}>
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
                <Pressable
                  accessibilityLabel={`Create a port forward through ${login} on ${server.hostname}`}
                  accessibilityRole="button"
                  onPress={() => onOpenForward(server, login)}
                  style={({ pressed }) => [styles.forwardButton, pressed && styles.pressed]}
                >
                  <Text style={styles.forwardButtonText}>⇄</Text>
                </Pressable>
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

function FilterChip({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.filterChip,
        active && styles.filterChipActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const nodeSortOptions: {
  value: NodeSortMode;
  label: string;
  detail: string;
  shortLabel?: string;
}[] = [
  { value: 'smart', label: 'Smart', detail: 'Favorites, recents, then online nodes' },
  { value: 'hostname', label: 'Hostname', detail: 'Alphabetical by node name' },
  { value: 'labels', label: 'Labels', detail: 'Alphabetical by label key and value' },
  { value: 'cluster', label: 'Cluster', detail: 'Cluster first, then hostname' },
  { value: 'status', label: 'Status', detail: 'Online nodes first' },
  {
    value: 'recent',
    label: 'Last connection',
    shortLabel: 'Recent',
    detail: 'Most recently connected first',
  },
];

function sortModeLabel(mode: NodeSortMode) {
  const option = nodeSortOptions.find(value => value.value === mode);
  return option?.shortLabel ?? option?.label ?? 'Smart';
}

function filterAndSortServers(
  servers: TeleportServer[],
  clusterName: string,
  preferences: ProfileNodePreferences
) {
  const favoriteServerIds = new Set(preferences.favoriteServerIds);
  const needle = preferences.view.query.trim().toLocaleLowerCase();
  const visible = servers.filter(server => {
    const recent = preferences.recentConnections[server.id];
    if (preferences.view.favoritesOnly && !favoriteServerIds.has(server.id)) return false;
    if (preferences.view.recentOnly && !recent) return false;
    if (preferences.view.onlineOnly && server.status !== 'online') return false;
    if (!needle) return true;
    return [
      server.hostname,
      server.address,
      server.status,
      server.clusterName ?? clusterName,
      ...Object.entries(server.labels ?? {}).flatMap(([key, value]) => [key, value]),
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(needle);
  });

  return [...visible].sort((left, right) => {
    const leftRecent = preferences.recentConnections[left.id];
    const rightRecent = preferences.recentConnections[right.id];
    const hostnameOrder = left.hostname.localeCompare(right.hostname);
    switch (preferences.view.sortMode) {
      case 'hostname':
        return hostnameOrder;
      case 'labels':
        return labelSortKey(left).localeCompare(labelSortKey(right)) || hostnameOrder;
      case 'cluster':
        return (left.clusterName ?? clusterName).localeCompare(right.clusterName ?? clusterName)
          || hostnameOrder;
      case 'status':
        return statusRank(left) - statusRank(right) || hostnameOrder;
      case 'recent':
        return recentTimestamp(rightRecent) - recentTimestamp(leftRecent) || hostnameOrder;
      case 'smart':
      default:
        return Number(favoriteServerIds.has(right.id)) - Number(favoriteServerIds.has(left.id))
          || recentTimestamp(rightRecent) - recentTimestamp(leftRecent)
          || statusRank(left) - statusRank(right)
          || hostnameOrder;
    }
  });
}

function labelSortKey(server: TeleportServer) {
  return Object.entries(server.labels ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(' ');
}

function statusRank(server: TeleportServer) {
  return server.status === 'online' ? 0 : 1;
}

function recentTimestamp(recent?: RecentNodePreference) {
  if (!recent) return 0;
  const timestamp = Date.parse(recent.lastConnectedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatRelativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'recently';
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

function messageFrom(error: unknown) {
  return rawErrorMessage(error);
}

function formatRetryDelay(delayMs: number) {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return `${seconds}s`;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.ink },
  content: { alignItems: 'center', padding: space.lg, paddingBottom: space.xxl },
  contentCompact: { padding: space.md, paddingBottom: space.xl },
  contentShort: { paddingVertical: space.md },
  page: { width: '100%', maxWidth: responsiveLayout.contentMaxWidth, gap: space.lg },
  topline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  forwardsLink: { color: palette.signal, fontFamily: type.monoMedium, fontSize: 9 },
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
  discoveryTools: { gap: space.sm },
  filterRail: { flexGrow: 1, alignItems: 'center', gap: space.xs, paddingRight: space.xs },
  filterChip: {
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: palette.rule,
    borderWidth: 1,
    borderRadius: radius.pill,
    backgroundColor: palette.panel,
    paddingHorizontal: space.md,
  },
  filterChipActive: { borderColor: palette.copper, backgroundColor: palette.raised },
  filterChipText: { color: palette.mist, fontFamily: type.monoMedium, fontSize: 9 },
  filterChipTextActive: { color: palette.copper },
  sortButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderColor: palette.rule,
    borderWidth: 1,
    borderRadius: radius.pill,
    backgroundColor: palette.panel,
    paddingHorizontal: space.md,
  },
  sortButtonOpen: { borderColor: palette.signal, backgroundColor: palette.raised },
  sortCaption: { color: palette.quiet, fontFamily: type.monoStrong, fontSize: 7, letterSpacing: 0.8 },
  sortValue: { color: palette.porcelain, fontFamily: type.monoMedium, fontSize: 9 },
  sortChevron: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 10 },
  sortMenu: { gap: 3, padding: space.xs },
  sortChoice: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderColor: 'transparent',
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
  },
  sortChoiceActive: { borderColor: palette.signal, backgroundColor: palette.raised },
  sortChoiceDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.quiet },
  sortChoiceDotActive: { backgroundColor: palette.signal },
  sortChoiceCopy: { flex: 1, minWidth: 0 },
  sortChoiceLabel: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 10 },
  sortChoiceDetail: { color: palette.quiet, fontFamily: type.mono, fontSize: 8, marginTop: 2 },
  loader: { marginVertical: space.xl },
  errorBlock: { gap: space.sm },
  serverList: { gap: space.md },
  serverListCompact: { gap: 12 },
  serverGrid: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: responsiveLayout.nodeGap, alignItems: 'flex-start' },
  count: { color: palette.quiet, fontFamily: type.mono, fontSize: 10, letterSpacing: 0.7, textTransform: 'uppercase' },
  serverCard: { gap: space.md },
  serverCardFull: { width: '100%' },
  serverCardCompact: { gap: 14, padding: 14 },
  serverCardFavorite: { borderColor: palette.copperMuted },
  serverCardActive: { borderColor: palette.signal },
  serverHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  serverHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  favoriteButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  favoriteIcon: { color: palette.quiet, fontFamily: type.monoMedium, fontSize: 18, lineHeight: 20 },
  favoriteIconActive: { color: palette.copper },
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
  recentBadge: { maxWidth: '100%', flexShrink: 1, borderRadius: radius.pill, backgroundColor: palette.raised, paddingHorizontal: space.sm, paddingVertical: 5 },
  recentBadgeText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.4 },
  arrow: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 20, lineHeight: 22 },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  label: { color: palette.mist, backgroundColor: palette.raised, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 5, fontFamily: type.mono, fontSize: 9 },
  loginRow: { borderTopColor: palette.rule, borderTopWidth: 1, paddingTop: space.md, gap: space.sm },
  loginCaptionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.xs },
  loginCaption: { color: palette.quiet, fontFamily: type.mono, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.8 },
  preferredLogin: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.4 },
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
  forwardButton: {
    minWidth: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.rule,
    borderRadius: radius.sm,
    backgroundColor: palette.deep,
  },
  forwardButtonText: { color: palette.copper, fontFamily: type.monoStrong, fontSize: 13 },
  loginButton: { borderColor: palette.copperMuted, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  loginButtonPreferred: { borderColor: palette.copper, backgroundColor: palette.raised },
  loginButtonActive: { borderColor: palette.signal, backgroundColor: palette.raised },
  loginText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 11 },
  loginTextPreferred: { color: palette.porcelain },
  loginTextActive: { color: palette.signal },
  noLogins: { color: palette.warning, fontFamily: type.mono, fontSize: 10 },
  emptyResults: { gap: space.sm },
  clearFilters: { minHeight: 40, alignItems: 'center', justifyContent: 'center', borderColor: palette.copperMuted, borderWidth: 1, borderRadius: radius.sm },
  clearFiltersText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 9 },
  pressed: { opacity: 0.65 },
});
