import { useEffect } from 'react';
import { AppState } from 'react-native';

import { getTeleportClient } from '@/lib/teleport/client';
import {
  loadSessionSnapshot,
  saveSessionSnapshot,
} from '@/lib/teleport/profile-store';

const checkIntervalMs = 15_000;

export function useTeleportSessionKeepAlive() {
  useEffect(() => {
    let mounted = true;
    let refreshing = false;

    async function refresh() {
      if (!mounted || refreshing || AppState.currentState !== 'active') return;
      refreshing = true;
      try {
        const saved = await loadSessionSnapshot();
        if (!saved) return;
        const renewed = await getTeleportClient().exportSession();
        if (renewed !== saved) await saveSessionSnapshot(renewed);
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
