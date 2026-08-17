import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  clearAllNodePreferences,
  removeProfileNodePreferences,
} from '@/lib/teleport/node-preferences';
import type {
  AuthMethod,
  AuthenticatedProfile,
  SavedTeleportProfile,
  TeleportProfileStore,
} from '@/types/teleport';

const storeKey = 'telemob.profiles.v2';
const legacyProfileKey = 'telemob.active-profile';
const legacySessionKey = 'telemob.active-session';
const profileSessionKey = (profileId: string) => `telemob.profile-session.${profileId}`;
const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let writeQueue: Promise<unknown> = Promise.resolve();
let migrationPromise: Promise<void> | undefined;

type SaveProfileOptions = {
  authMethod: AuthMethod;
  insecure: boolean;
  name?: string;
};

type StoredProfile = Omit<SavedTeleportProfile, 'sessionSnapshot'>;
type StoredProfileIndex = {
  version: 2;
  activeProfileId: string | null;
  profiles: StoredProfile[];
};

export async function loadProfileStore(): Promise<TeleportProfileStore> {
  await writeQueue.catch(() => undefined);
  await ensureMigrated();
  return readStoreNow();
}

export async function listSavedProfiles() {
  return sortProfiles((await loadProfileStore()).profiles);
}

export async function loadActiveSavedProfile() {
  const store = await loadProfileStore();
  return store.profiles.find(profile => profile.id === store.activeProfileId) ?? null;
}

export async function loadSavedProfile(profileId: string) {
  const store = await loadProfileStore();
  return store.profiles.find(profile => profile.id === profileId) ?? null;
}

export function saveAuthenticatedProfile(
  profile: AuthenticatedProfile,
  sessionSnapshot: string,
  options: SaveProfileOptions
) {
  return updateStore(store => {
    const now = new Date().toISOString();
    const existing = store.profiles.find(saved => sameIdentity(saved.profile, profile));
    const saved: SavedTeleportProfile = existing
      ? {
          ...existing,
          name: options.name?.trim() || existing.name,
          profile,
          sessionSnapshot,
          authMethod: options.authMethod,
          insecure: options.insecure,
          lastUsedAt: now,
          signedOutAt: undefined,
        }
      : {
          id: createProfileId(),
          name: options.name?.trim() || defaultProfileName(profile),
          profile,
          sessionSnapshot,
          authMethod: options.authMethod,
          insecure: options.insecure,
          createdAt: now,
          lastUsedAt: now,
        };
    const profiles = existing
      ? store.profiles.map(value => value.id === existing.id ? saved : value)
      : [...store.profiles, saved];
    return [{ ...store, activeProfileId: saved.id, profiles }, saved] as const;
  });
}

export function selectSavedProfile(profileId: string) {
  return updateStore(store => {
    const selected = store.profiles.find(profile => profile.id === profileId);
    if (!selected) throw new Error('The selected Teleport profile no longer exists.');
    const updated = { ...selected, lastUsedAt: new Date().toISOString() };
    return [
      {
        ...store,
        activeProfileId: profileId,
        profiles: store.profiles.map(profile => profile.id === profileId ? updated : profile),
      },
      updated,
    ] as const;
  });
}

export function saveProfileSession(
  profileId: string,
  sessionSnapshot: string,
  authenticatedProfile?: AuthenticatedProfile
) {
  return updateStore(store => {
    const current = store.profiles.find(profile => profile.id === profileId);
    if (!current) return [store, null] as const;
    const snapshot = sessionFreshness(current.sessionSnapshot) > sessionFreshness(sessionSnapshot)
      ? current.sessionSnapshot
      : sessionSnapshot;
    const updated: SavedTeleportProfile = {
      ...current,
      profile: authenticatedProfile ?? current.profile,
      sessionSnapshot: snapshot,
      signedOutAt: undefined,
    };
    return [
      {
        ...store,
        profiles: store.profiles.map(profile => profile.id === profileId ? updated : profile),
      },
      updated,
    ] as const;
  });
}

export function markSavedProfileSignedOut(profileId: string) {
  return updateStore(store => {
    const current = store.profiles.find(profile => profile.id === profileId);
    if (!current) throw new Error('The selected Teleport profile no longer exists.');
    const now = new Date().toISOString();
    const updated: SavedTeleportProfile = {
      ...current,
      sessionSnapshot: null,
      signedOutAt: now,
      lastUsedAt: now,
    };
    return [
      {
        ...store,
        profiles: store.profiles.map(profile => profile.id === profileId ? updated : profile),
      },
      updated,
    ] as const;
  });
}

export function renameSavedProfile(profileId: string, name: string) {
  const nextName = name.trim();
  if (!nextName) return Promise.reject(new Error('Enter a profile name.'));
  return updateStore(store => {
    const current = store.profiles.find(profile => profile.id === profileId);
    if (!current) throw new Error('The selected Teleport profile no longer exists.');
    const updated = { ...current, name: nextName };
    return [
      {
        ...store,
        profiles: store.profiles.map(profile => profile.id === profileId ? updated : profile),
      },
      updated,
    ] as const;
  });
}

export function removeSavedProfile(profileId: string) {
  return updateStore(store => {
    const profiles = store.profiles.filter(profile => profile.id !== profileId);
    const activeProfileId = store.activeProfileId === profileId
      ? sortProfiles(profiles)[0]?.id ?? null
      : store.activeProfileId;
    const updated: TeleportProfileStore = {
      ...store,
      activeProfileId,
      profiles,
    };
    return [updated, updated] as const;
  }).then(async store => {
    await removeProfileNodePreferences(profileId);
    return store;
  });
}

export function clearAllProfiles() {
  return enqueueWrite(async () => {
    const store = await readStoreNow();
    await Promise.all([
      removeValue(storeKey),
      removeValue(legacyProfileKey),
      removeValue(legacySessionKey),
      clearAllNodePreferences(store.profiles.map(profile => profile.id)),
      ...store.profiles.map(profile => removeValue(profileSessionKey(profile.id))),
    ]);
  });
}

async function ensureMigrated() {
  migrationPromise ??= migrateLegacyStore();
  await migrationPromise;
}

async function migrateLegacyStore() {
  if (await readValue(storeKey)) return;
  const [profileJSON, sessionSnapshot] = await Promise.all([
    readValue(legacyProfileKey),
    readValue(legacySessionKey),
  ]);
  if (!profileJSON || !sessionSnapshot) return;
  try {
    const profile = JSON.parse(profileJSON) as AuthenticatedProfile;
    if (!isAuthenticatedProfile(profile)) return;
    const now = new Date().toISOString();
    const saved: SavedTeleportProfile = {
      id: createProfileId(),
      name: defaultProfileName(profile),
      profile,
      sessionSnapshot,
      authMethod: 'totp',
      insecure: snapshotUsesInsecureTLS(sessionSnapshot),
      createdAt: now,
      lastUsedAt: now,
    };
    await writeStoreNow({ version: 2, activeProfileId: saved.id, profiles: [saved] });
    await Promise.all([
      removeValue(legacyProfileKey),
      removeValue(legacySessionKey),
    ]);
  } catch {
    // Keep invalid legacy data so a future migration can attempt recovery.
  }
}

function updateStore<Result>(
  mutation: (store: TeleportProfileStore) => readonly [TeleportProfileStore, Result]
) {
  return enqueueWrite(async () => {
    await ensureMigrated();
    const [next, result] = mutation(await readStoreNow());
    await writeStoreNow(next);
    return result;
  });
}

function enqueueWrite<Result>(operation: () => Promise<Result>) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readStoreNow(): Promise<TeleportProfileStore> {
  const stored = await readValue(storeKey);
  if (!stored) return emptyStore();
  try {
    const parsed = JSON.parse(stored) as Partial<StoredProfileIndex>;
    if (parsed.version !== 2 || !Array.isArray(parsed.profiles)) return emptyStore();
    const storedProfiles = parsed.profiles.filter(isStoredProfile);
    const profiles = (await Promise.all(storedProfiles.map(async profile => {
      const sessionSnapshot = await readValue(profileSessionKey(profile.id));
      return { ...profile, sessionSnapshot };
    })));
    const activeProfileId = profiles.some(profile => profile.id === parsed.activeProfileId)
      ? parsed.activeProfileId ?? null
      : sortProfiles(profiles)[0]?.id ?? null;
    return { version: 2, activeProfileId, profiles };
  } catch {
    return emptyStore();
  }
}

function emptyStore(): TeleportProfileStore {
  return { version: 2, activeProfileId: null, profiles: [] };
}

function writeStoreNow(store: TeleportProfileStore) {
  return writeStoreValues(store);
}

async function writeStoreValues(store: TeleportProfileStore) {
  const previous = await readStoredProfileIds();
  const index: StoredProfileIndex = {
    version: 2,
    activeProfileId: store.activeProfileId,
    profiles: store.profiles.map(({ sessionSnapshot: _sessionSnapshot, ...profile }) => profile),
  };
  const current = new Set(store.profiles.map(profile => profile.id));
  await Promise.all(store.profiles.map(profile => profile.sessionSnapshot
    ? writeValue(profileSessionKey(profile.id), profile.sessionSnapshot)
    : removeValue(profileSessionKey(profile.id))));
  await writeValue(storeKey, JSON.stringify(index));
  await Promise.all(previous
    .filter(profileId => !current.has(profileId))
    .map(profileId => removeValue(profileSessionKey(profileId))));
}

async function readStoredProfileIds() {
  const stored = await readValue(storeKey);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as Partial<StoredProfileIndex>;
    return Array.isArray(parsed.profiles)
      ? parsed.profiles
          .map(profile => profile?.id)
          .filter((profileId): profileId is string => typeof profileId === 'string')
      : [];
  } catch {
    return [];
  }
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

function sortProfiles(profiles: SavedTeleportProfile[]) {
  return [...profiles].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
}

function sameIdentity(left: AuthenticatedProfile, right: AuthenticatedProfile) {
  return normalizeProxy(left.proxyAddress) === normalizeProxy(right.proxyAddress)
    && left.username.toLocaleLowerCase() === right.username.toLocaleLowerCase();
}

function normalizeProxy(value: string) {
  return value.trim().replace(/\/$/, '').toLocaleLowerCase();
}

function defaultProfileName(profile: AuthenticatedProfile) {
  return profile.clusterName || profile.proxyAddress;
}

function createProfileId() {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function isAuthenticatedProfile(value: unknown): value is AuthenticatedProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<AuthenticatedProfile>;
  return typeof profile.proxyAddress === 'string'
    && typeof profile.username === 'string'
    && typeof profile.clusterName === 'string'
    && typeof profile.validUntil === 'string';
}

function isStoredProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<StoredProfile>;
  return typeof profile.id === 'string'
    && typeof profile.name === 'string'
    && isAuthenticatedProfile(profile.profile)
    && (profile.authMethod === 'passkey' || profile.authMethod === 'totp')
    && typeof profile.insecure === 'boolean'
    && typeof profile.createdAt === 'string'
    && typeof profile.lastUsedAt === 'string';
}

function sessionFreshness(snapshot: string | null) {
  if (!snapshot) return 0;
  try {
    const value = JSON.parse(snapshot);
    const timestamp = value.tokenExpiresAt ?? value.expiresAt ?? value.profile?.validUntil;
    const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function snapshotUsesInsecureTLS(snapshot: string) {
  try {
    return JSON.parse(snapshot)?.insecure === true;
  } catch {
    return false;
  }
}
