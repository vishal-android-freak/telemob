import * as Network from 'expo-network';
import { Platform } from 'react-native';

export type ConnectivitySnapshot = {
  generation: number;
  type: Network.NetworkStateType;
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  ipAddress: string;
  available: boolean;
};

type ConnectivityListener = (snapshot: ConnectivitySnapshot) => void;

const listeners = new Set<ConnectivityListener>();
let started = false;
let observation = 0;
let snapshot: ConnectivitySnapshot = {
  generation: 0,
  type: Network.NetworkStateType.UNKNOWN,
  isConnected: null,
  isInternetReachable: null,
  ipAddress: '',
  available: true,
};

export function getConnectivitySnapshot() {
  return snapshot;
}

export function subscribeConnectivity(listener: ConnectivityListener) {
  listeners.add(listener);
  startConnectivityMonitor();
  listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshConnectivity() {
  startConnectivityMonitor();
  try {
    await observeNetworkState(await Network.getNetworkStateAsync());
  } catch {
    // A failed observation must not make an otherwise reachable local proxy
    // appear offline. The next native event can still update the snapshot.
  }
  return snapshot;
}

export function waitForConnectivityChange({
  afterGeneration,
  requireAvailable,
  signal,
  timeoutMs,
}: {
  afterGeneration: number;
  requireAvailable: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  startConnectivityMonitor();
  if (signal?.aborted) return Promise.reject(abortError());
  if (
    snapshot.generation > afterGeneration
    && (!requireAvailable || snapshot.available)
  ) {
    return Promise.resolve(snapshot);
  }

  return new Promise<ConnectivitySnapshot>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    const finish = (next?: ConnectivitySnapshot, error?: Error) => {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(next ?? snapshot);
    };
    const onChange = (next: ConnectivitySnapshot) => {
      if (
        next.generation > afterGeneration
        && (!requireAvailable || next.available)
      ) {
        finish(next);
      }
    };
    const onAbort = () => finish(undefined, abortError());
    unsubscribe = subscribeConnectivity(onChange);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof timeoutMs === 'number') {
      timer = setTimeout(() => finish(snapshot), timeoutMs);
    }
  });
}

export function connectivityLabel(value: ConnectivitySnapshot) {
  switch (value.type) {
    case Network.NetworkStateType.WIFI:
      return 'Wi-Fi';
    case Network.NetworkStateType.CELLULAR:
      return 'cellular';
    case Network.NetworkStateType.ETHERNET:
      return 'Ethernet';
    case Network.NetworkStateType.VPN:
      return 'VPN';
    case Network.NetworkStateType.NONE:
      return 'offline';
    default:
      return 'network';
  }
}

function startConnectivityMonitor() {
  if (started) return;
  started = true;
  Network.addNetworkStateListener(state => {
    void observeNetworkState(state);
  });
  void refreshConnectivity();
}

async function observeNetworkState(state: Network.NetworkState) {
  const currentObservation = ++observation;
  const type = state.type ?? Network.NetworkStateType.UNKNOWN;
  let ipAddress = '';
  if (
    type !== Network.NetworkStateType.NONE
    && Platform.OS !== 'web'
  ) {
    try {
      ipAddress = await Network.getIpAddressAsync();
    } catch {
      // Type and reachability are still useful when the IP is unavailable.
    }
  }
  if (currentObservation !== observation) return;

  const next = {
    type,
    isConnected: state.isConnected ?? null,
    isInternetReachable: state.isInternetReachable ?? null,
    ipAddress,
    available:
      type !== Network.NetworkStateType.NONE
      && state.isConnected !== false,
  };
  if (sameConnectivity(snapshot, next)) return;
  snapshot = {
    ...next,
    generation: snapshot.generation + 1,
  };
  listeners.forEach(listener => listener(snapshot));
}

function sameConnectivity(
  left: ConnectivitySnapshot,
  right: Omit<ConnectivitySnapshot, 'generation'>
) {
  return left.type === right.type
    && left.isConnected === right.isConnected
    && left.isInternetReachable === right.isInternetReachable
    && left.ipAddress === right.ipAddress
    && left.available === right.available;
}

function abortError() {
  const error = new Error('Connection recovery was cancelled.');
  error.name = 'AbortError';
  return error;
}
