import { useSyncExternalStore } from 'react';

import {
  getConnectivitySnapshot,
  subscribeConnectivity,
} from '@/lib/network/connectivity';

export function useConnectivity() {
  return useSyncExternalStore(
    subscribeConnectivity,
    getConnectivitySnapshot,
    getConnectivitySnapshot
  );
}
