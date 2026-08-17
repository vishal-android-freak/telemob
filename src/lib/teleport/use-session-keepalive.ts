import { useEffect } from 'react';
import { AppState } from 'react-native';

import { refreshSavedProfile } from '@/lib/teleport/profile-session';
import { loadActiveSavedProfile } from '@/lib/teleport/profile-store';

const checkIntervalMs = 15_000;

export function useTeleportSessionKeepAlive() {
  useEffect(() => {
    let mounted = true;
    let refreshing = false;

    async function refresh() {
      if (!mounted || refreshing || AppState.currentState !== 'active') return;
      refreshing = true;
      try {
        const saved = await loadActiveSavedProfile();
        if (!saved) return;
        await refreshSavedProfile(saved.id);
      } catch {
        // Screens that need authentication surface expiry and route to login.
      } finally {
        refreshing = false;
      }
    }

    const timer = setInterval(() => void refresh(), checkIntervalMs);
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh();
    });
    void refresh();

    return () => {
      mounted = false;
      clearInterval(timer);
      appStateSubscription.remove();
    };
  }, []);
}
