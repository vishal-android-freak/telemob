import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
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
} from '@/components/shell-ui';
import { palette, radius, space, type } from '@/constants/tokens';
import { getTeleportClient } from '@/lib/teleport/client';
import {
  clearProfile,
  loadProfile,
  loadSessionSnapshot,
  saveSessionSnapshot,
} from '@/lib/teleport/profile-store';
import {
  getTerminalSessionManager,
  type TerminalConnectionState,
} from '@/lib/terminal/session-manager';
import type { AuthenticatedProfile, TeleportServer } from '@/types/teleport';

export default function ServersScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const compact = width <= 390;
  const [profile, setProfile] = useState<AuthenticatedProfile | null>(null);
  const [servers, setServers] = useState<TeleportServer[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [terminalManager] = useState(getTerminalSessionManager);
  const [terminalSession, setTerminalSession] = useState(terminalManager.getSnapshot);

  useEffect(() => {
    const unsubscribe = terminalManager.subscribe(setTerminalSession);
    return () => {
      unsubscribe();
    };
  }, [terminalManager]);

  useEffect(() => {
    let active = true;
    async function loadServers() {
      try {
        const [nextProfile, snapshot] = await Promise.all([
          loadProfile(),
          loadSessionSnapshot(),
        ]);
        if (!nextProfile || !snapshot) {
          router.replace('/');
          return;
        }
        try {
          await getTeleportClient().restoreSession(snapshot);
        } catch {
          await clearProfile();
          router.replace('/');
          return;
        }
        const nextServers = await getTeleportClient().listServers();
        const refreshedSnapshot = await getTeleportClient().exportSession();
        await saveSessionSnapshot(refreshedSnapshot);
        if (!active) return;
        setProfile(nextProfile);
        setServers(Array.isArray(nextServers) ? nextServers : []);
      } catch (loadError) {
        if (isForbidden(loadError)) {
          await Promise.all([clearProfile(), getTeleportClient().logout()]);
          if (active) {
            router.replace({
              pathname: '/',
              params: { reason: 'session-expired' },
            });
          }
          return;
        }
        if (active) setError(messageFrom(loadError));
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadServers();
    return () => {
      active = false;
    };
  }, [router]);

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

  const activeTarget = isActiveTerminalState(terminalSession.state)
    ? terminalSession.target
    : undefined;

  async function signOut() {
    await Promise.all([clearProfile(), getTeleportClient().logout()]);
    router.replace('/');
  }

  function openServer(server: TeleportServer, login: string) {
    router.push({
      pathname: '/terminal/[serverId]',
      params: { serverId: server.id, hostname: server.hostname, login },
    });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={[styles.content, compact && styles.contentCompact]}>
        <View style={styles.topline}>
          <View style={styles.identity}>
            <View style={styles.liveDot} />
            <View>
              <Text style={styles.cluster}>{profile?.clusterName ?? 'Cluster'}</Text>
              <Text style={styles.user}>{profile?.username ?? 'operator'} / active identity</Text>
            </View>
          </View>
          <Pressable onPress={signOut} hitSlop={10}>
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>

        <Text style={[styles.title, compact && styles.titleCompact]}>
          Choose the node for login
        </Text>

        {profile?.proxyAddress === 'demo.telemob.invalid'
          && profile.username === 'play-review' ? (
            <Notice>Offline store-review demo active. No external proxy is connected.</Notice>
          ) : null}

        <Field
          accessibilityLabel="Filter servers"
          value={query}
          onChangeText={setQuery}
          placeholder="Filter by host, role, region…"
        />

        {error ? <Notice tone="error">{error}</Notice> : null}
        {loading ? (
          <ActivityIndicator color={palette.copper} style={styles.loader} />
        ) : (
          <View style={[styles.serverList, compact && styles.serverListCompact]}>
            <Text style={styles.count}>{filtered.length} nodes available</Text>
            {filtered.map(server => (
              <ServerCard
                activeLogin={activeTarget?.serverId === server.id ? activeTarget.login : undefined}
                compact={compact}
                key={server.id}
                server={server}
                onOpen={openServer}
              />
            ))}
            {!filtered.length && (
              <Notice>No nodes match this filter.</Notice>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ServerCard({
  activeLogin,
  compact,
  server,
  onOpen,
}: {
  activeLogin?: string;
  compact: boolean;
  server: TeleportServer;
  onOpen: (server: TeleportServer, login: string) => void;
}) {
  return (
    <Panel style={[
      styles.serverCard,
      compact && styles.serverCardCompact,
      activeLogin && styles.serverCardActive,
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
              {activeLogin ? (
                <View style={styles.activeBadge}>
                  <View style={styles.activeBadgeDot} />
                  <Text numberOfLines={1} style={styles.activeBadgeText}>
                    {activeLogin} session active
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
          {(server.logins ?? []).map(login => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: activeLogin === login }}
              key={login}
              onPress={() => onOpen(server, login)}
              style={({ pressed }) => [
                styles.loginButton,
                activeLogin === login && styles.loginButtonActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.loginText, activeLogin === login && styles.loginTextActive]}>
                {login}
              </Text>
            </Pressable>
          ))}
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

function isForbidden(error: unknown) {
  return /\bHTTP 403\b/i.test(messageFrom(error));
}

function isActiveTerminalState(state: TerminalConnectionState) {
  return state === 'connecting'
    || state === 'connected'
    || state === 'checking'
    || state === 'reconnecting';
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.ink },
  content: { padding: space.lg, paddingBottom: space.xxl, gap: space.lg },
  contentCompact: { padding: space.md, paddingBottom: space.xl, gap: space.md },
  topline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.signal },
  cluster: { color: palette.porcelain, fontFamily: type.monoStrong, fontSize: 12 },
  user: { color: palette.quiet, fontFamily: type.mono, fontSize: 9, marginTop: 2 },
  signOut: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 11 },
  title: { color: palette.porcelain, fontFamily: type.display, fontSize: 34, lineHeight: 38, letterSpacing: -0.6 },
  titleCompact: { fontSize: 30, lineHeight: 34 },
  loader: { marginVertical: space.xl },
  serverList: { gap: space.md },
  serverListCompact: { gap: 12 },
  count: { color: palette.quiet, fontFamily: type.mono, fontSize: 10, letterSpacing: 0.7, textTransform: 'uppercase' },
  serverCard: { gap: space.md },
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
  loginButton: { borderColor: palette.copperMuted, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  loginButtonActive: { borderColor: palette.signal, backgroundColor: palette.raised },
  loginText: { color: palette.copper, fontFamily: type.monoMedium, fontSize: 11 },
  loginTextActive: { color: palette.signal },
  noLogins: { color: palette.warning, fontFamily: type.mono, fontSize: 10 },
  pressed: { opacity: 0.65 },
});
