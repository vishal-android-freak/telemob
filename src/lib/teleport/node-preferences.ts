import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type NodeSortMode =
  | 'smart'
  | 'hostname'
  | 'labels'
  | 'cluster'
  | 'status'
  | 'recent';

export type NodeViewPreferences = {
  query: string;
  favoritesOnly: boolean;
  recentOnly: boolean;
  onlineOnly: boolean;
  sortMode: NodeSortMode;
};

export type RecentNodePreference = {
  serverId: string;
  hostname: string;
  preferredLogin: string;
  lastConnectedAt: string;
  connectionCount: number;
};

export type ProfileNodePreferences = {
  favoriteServerIds: string[];
  recentConnections: Record<string, RecentNodePreference>;
  view: NodeViewPreferences;
};

const nodePreferenceKey = (profileId: string) =>
  `telemob.node-preferences.${profileId}.v1`;
const maxRecentNodes = 50;
const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let writeQueue: Promise<unknown> = Promise.resolve();

export function createDefaultNodePreferences(): ProfileNodePreferences {
  return {
    favoriteServerIds: [],
    recentConnections: {},
    view: {
      query: '',
      favoritesOnly: false,
      recentOnly: false,
      onlineOnly: false,
      sortMode: 'smart',
    },
  };
}

export async function loadProfileNodePreferences(
  profileId: string
): Promise<ProfileNodePreferences> {
  await writeQueue.catch(() => undefined);
  return readProfilePreferences(profileId);
}

export function saveNodeViewPreferences(
  profileId: string,
  view: NodeViewPreferences
) {
  return updateProfilePreferences(profileId, current => {
    const updated = { ...current, view: normalizeViewPreferences(view) };
    return [updated, updated] as const;
  });
}

export function setNodeFavorite(
  profileId: string,
  serverId: string,
  favorite: boolean
) {
  return updateProfilePreferences(profileId, current => {
    const favoriteServerIds = favorite
      ? [...new Set([...current.favoriteServerIds, serverId])]
      : current.favoriteServerIds.filter(id => id !== serverId);
    const updated = { ...current, favoriteServerIds };
    return [updated, updated] as const;
  });
}

export function recordNodeConnection(
  profileId: string,
  target: { serverId: string; hostname: string; login: string }
) {
  return updateProfilePreferences(profileId, current => {
    const previous = current.recentConnections[target.serverId];
    const connected: RecentNodePreference = {
      serverId: target.serverId,
      hostname: target.hostname,
      preferredLogin: target.login,
      lastConnectedAt: new Date().toISOString(),
      connectionCount: (previous?.connectionCount ?? 0) + 1,
    };
    const recentConnections = Object.fromEntries(
      Object.entries({
        ...current.recentConnections,
        [target.serverId]: connected,
      })
        .sort(([, left], [, right]) =>
          right.lastConnectedAt.localeCompare(left.lastConnectedAt)
        )
        .slice(0, maxRecentNodes)
    );
    const updated = { ...current, recentConnections };
    return [updated, updated] as const;
  });
}

export function removeProfileNodePreferences(profileId: string) {
  return enqueueWrite(() => removeValue(nodePreferenceKey(profileId)));
}

export function clearAllNodePreferences(profileIds: string[]) {
  return enqueueWrite(() => Promise.all(
    profileIds.map(profileId => removeValue(nodePreferenceKey(profileId)))
  ).then(() => undefined));
}

function updateProfilePreferences<Result>(
  profileId: string,
  mutation: (
    preferences: ProfileNodePreferences
  ) => readonly [ProfileNodePreferences, Result]
) {
  return enqueueWrite(async () => {
    const [next, result] = mutation(await readProfilePreferences(profileId));
    await writeValue(nodePreferenceKey(profileId), JSON.stringify(next));
    return result;
  });
}

function enqueueWrite<Result>(operation: () => Promise<Result>) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readProfilePreferences(profileId: string) {
  const stored = await readValue(nodePreferenceKey(profileId));
  if (!stored) return createDefaultNodePreferences();
  try {
    return normalizeProfilePreferences(JSON.parse(stored));
  } catch {
    return createDefaultNodePreferences();
  }
}

function normalizeProfilePreferences(value: unknown): ProfileNodePreferences {
  const defaults = createDefaultNodePreferences();
  if (!value || typeof value !== 'object') return defaults;
  const candidate = value as Partial<ProfileNodePreferences>;
  const favoriteServerIds = Array.isArray(candidate.favoriteServerIds)
    ? candidate.favoriteServerIds.filter((id): id is string => typeof id === 'string')
    : [];
  const recentConnections = candidate.recentConnections
    && typeof candidate.recentConnections === 'object'
    ? Object.fromEntries(Object.entries(candidate.recentConnections)
        .filter((entry): entry is [string, RecentNodePreference] =>
          isRecentNodePreference(entry[1])
        ))
    : {};
  return {
    favoriteServerIds: [...new Set(favoriteServerIds)],
    recentConnections,
    view: normalizeViewPreferences(candidate.view),
  };
}

function normalizeViewPreferences(value: unknown): NodeViewPreferences {
  const defaults = createDefaultNodePreferences().view;
  if (!value || typeof value !== 'object') return defaults;
  const candidate = value as Partial<NodeViewPreferences>;
  return {
    query: typeof candidate.query === 'string' ? candidate.query : '',
    favoritesOnly: candidate.favoritesOnly === true,
    recentOnly: candidate.recentOnly === true,
    onlineOnly: candidate.onlineOnly === true,
    sortMode: isNodeSortMode(candidate.sortMode) ? candidate.sortMode : 'smart',
  };
}

function isNodeSortMode(value: unknown): value is NodeSortMode {
  return value === 'smart'
    || value === 'hostname'
    || value === 'labels'
    || value === 'cluster'
    || value === 'status'
    || value === 'recent';
}

function isRecentNodePreference(value: unknown): value is RecentNodePreference {
  if (!value || typeof value !== 'object') return false;
  const recent = value as Partial<RecentNodePreference>;
  return typeof recent.serverId === 'string'
    && typeof recent.hostname === 'string'
    && typeof recent.preferredLogin === 'string'
    && typeof recent.lastConnectedAt === 'string'
    && typeof recent.connectionCount === 'number';
}

function readValue(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return Promise.resolve(globalThis.localStorage?.getItem(key) ?? null);
  }
  return SecureStore.getItemAsync(key);
}

function writeValue(key: string, value: string) {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(key, value);
    return Promise.resolve();
  }
  return SecureStore.setItemAsync(key, value, secureStoreOptions);
}

function removeValue(key: string) {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.removeItem(key);
    return Promise.resolve();
  }
  return SecureStore.deleteItemAsync(key);
}
