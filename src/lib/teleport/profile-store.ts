import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { AuthenticatedProfile } from '@/types/teleport';

const profileKey = 'telemob.active-profile';
const sessionKey = 'telemob.active-session';
const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
let sessionWriteQueue: Promise<void> = Promise.resolve();
let sessionWritesEnabled = true;

export async function saveProfile(profile: AuthenticatedProfile) {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(profileKey, JSON.stringify(profile));
    sessionWritesEnabled = true;
    return;
  }
  await SecureStore.setItemAsync(profileKey, JSON.stringify(profile), secureStoreOptions);
  sessionWritesEnabled = true;
}

export function saveSessionSnapshot(snapshot: string) {
  const write = sessionWriteQueue.then(() => {
    if (!sessionWritesEnabled) return;
    return saveSessionSnapshotNow(snapshot);
  });
  sessionWriteQueue = write.catch(() => undefined);
  return write;
}

async function saveSessionSnapshotNow(snapshot: string) {
  const stored = await loadSessionSnapshot();
  if (stored && sessionFreshness(stored) > sessionFreshness(snapshot)) return;
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(sessionKey, snapshot);
    return;
  }
  await SecureStore.setItemAsync(sessionKey, snapshot, secureStoreOptions);
}

export async function loadSessionSnapshot(): Promise<string | null> {
  return Platform.OS === 'web'
    ? globalThis.localStorage?.getItem(sessionKey) ?? null
    : await SecureStore.getItemAsync(sessionKey);
}

export async function loadProfile(): Promise<AuthenticatedProfile | null> {
  const stored =
    Platform.OS === 'web'
      ? globalThis.localStorage?.getItem(profileKey)
      : await SecureStore.getItemAsync(profileKey);
  return stored ? JSON.parse(stored) : null;
}

export async function clearProfile() {
  sessionWritesEnabled = false;
  await sessionWriteQueue;
  if (Platform.OS === 'web') {
    globalThis.localStorage?.removeItem(profileKey);
    globalThis.localStorage?.removeItem(sessionKey);
    return;
  }
  await Promise.all([
    SecureStore.deleteItemAsync(profileKey),
    SecureStore.deleteItemAsync(sessionKey),
  ]);
}

function sessionFreshness(snapshot: string) {
  try {
    const value = JSON.parse(snapshot);
    const timestamp = value.tokenExpiresAt
      ?? value.expiresAt
      ?? value.profile?.validUntil;
    const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}
