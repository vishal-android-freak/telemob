import { getTeleportClient, type TeleportClient } from '@/lib/teleport/client';
import {
  loadSavedProfile,
  markSavedProfileSignedOut,
  saveProfileSession,
  selectSavedProfile,
} from '@/lib/teleport/profile-store';
import type { AuthenticatedProfile } from '@/types/teleport';

let nativeProfileId: string | undefined;
let activationQueue: Promise<unknown> = Promise.resolve();

export function markNativeProfileActive(profileId: string) {
  nativeProfileId = profileId;
}

export function forgetNativeProfile(profileId: string) {
  if (nativeProfileId === profileId) nativeProfileId = undefined;
}

export function activateSavedProfile(profileId: string) {
  return withProfileLock(async client => {
    const profile = await restoreProfileIfNeeded(client, profileId);
    await selectSavedProfile(profileId);
    return profile;
  });
}

export function withSavedProfile<Result>(
  profileId: string,
  operation: (client: TeleportClient) => Promise<Result>
) {
  return withProfileLock(async client => {
    await restoreProfileIfNeeded(client, profileId);
    let operationCompleted = false;
    try {
      const result = await operation(client);
      operationCompleted = true;
      return result;
    } finally {
      try {
        const snapshot = await client.exportSession();
        await saveProfileSession(profileId, snapshot);
      } catch (persistenceError) {
        if (operationCompleted) throw persistenceError;
      }
    }
  });
}

export function refreshSavedProfile(profileId: string) {
  return withProfileLock(async client => {
    const profile = await restoreProfileIfNeeded(client, profileId);
    const snapshot = await client.exportSession();
    await saveProfileSession(profileId, snapshot, profile);
    return profile;
  });
}

export function clearNativeAuthentication() {
  return withProfileLock(async client => {
    await client.logout();
    nativeProfileId = undefined;
  });
}

export function signOutSavedProfile(profileId: string) {
  return withProfileLock(async client => {
    if (nativeProfileId === profileId) {
      await client.logout().catch(() => undefined);
      nativeProfileId = undefined;
    }
    return markSavedProfileSignedOut(profileId);
  });
}

function withProfileLock<Result>(operation: (client: TeleportClient) => Promise<Result>) {
  const run = activationQueue.then(
    () => operation(getTeleportClient()),
    () => operation(getTeleportClient())
  );
  activationQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function restoreProfileIfNeeded(
  client: TeleportClient,
  profileId: string
): Promise<AuthenticatedProfile> {
  const saved = await loadSavedProfile(profileId);
  if (!saved) throw new Error('The selected Teleport profile no longer exists.');
  if (!saved.sessionSnapshot) {
    throw new Error('This Teleport profile is signed out. Sign in again to continue.');
  }
  if (nativeProfileId === profileId) return saved.profile;
  const restored = await client.restoreSession(saved.sessionSnapshot);
  nativeProfileId = profileId;
  await saveProfileSession(profileId, saved.sessionSnapshot, restored);
  return restored;
}
