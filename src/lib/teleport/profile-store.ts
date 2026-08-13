import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { AuthenticatedProfile } from '@/types/teleport';

const profileKey = 'telemob.active-profile';
const sessionKey = 'telemob.active-session';
const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function saveProfile(profile: AuthenticatedProfile) {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(profileKey, JSON.stringify(profile));
    return;
  }
  await SecureStore.setItemAsync(profileKey, JSON.stringify(profile), secureStoreOptions);
}

export async function saveSessionSnapshot(snapshot: string) {
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
