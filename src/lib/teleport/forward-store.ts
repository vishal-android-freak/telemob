import * as SecureStore from 'expo-secure-store';

import type { LocalForwardRequest } from '@/types/teleport';

export type SavedForwardRule = LocalForwardRequest & {
  id: string;
  createdAt: string;
};

type ForwardRuleStore = {
  version: 1;
  rules: SavedForwardRule[];
};

const secureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const keyForProfile = (profileId: string) => `telemob.forward-rules.${profileId}`;
let writeQueue: Promise<unknown> = Promise.resolve();

export async function loadForwardRules(profileId: string) {
  await writeQueue.catch(() => undefined);
  const encoded = await SecureStore.getItemAsync(keyForProfile(profileId));
  if (!encoded) return [];
  try {
    const store = JSON.parse(encoded) as ForwardRuleStore;
    return store.version === 1 && Array.isArray(store.rules) ? store.rules : [];
  } catch {
    return [];
  }
}

export function saveForwardRule(request: LocalForwardRequest) {
  return updateRules(request.profileId, rules => {
    const matching = rules.find(rule => sameRule(rule, request));
    if (matching) {
      return rules.map(rule => rule.id === matching.id ? { ...rule, ...request } : rule);
    }
    return [...rules, {
      ...request,
      id: `forward-rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    }];
  });
}

export function updateForwardRule(
  profileId: string,
  ruleId: string,
  request: LocalForwardRequest
) {
  return updateRules(profileId, rules => rules.map(rule =>
    rule.id === ruleId ? { ...rule, ...request, id: rule.id, createdAt: rule.createdAt } : rule
  ));
}

export function removeForwardRule(profileId: string, ruleId: string) {
  return updateRules(profileId, rules => rules.filter(rule => rule.id !== ruleId));
}

export function removeProfileForwardRules(profileId: string) {
  return enqueueRuleWrite(() => SecureStore.deleteItemAsync(keyForProfile(profileId)));
}

export function clearAllForwardRules(profileIds: string[]) {
  return enqueueRuleWrite(() => Promise.all(
    profileIds.map(profileId => SecureStore.deleteItemAsync(keyForProfile(profileId)))
  ).then(() => undefined));
}

function updateRules(
  profileId: string,
  update: (rules: SavedForwardRule[]) => SavedForwardRule[]
) {
  const operation = async () => {
    const rules = update(await loadForwardRulesNow(profileId));
    await SecureStore.setItemAsync(
      keyForProfile(profileId),
      JSON.stringify({ version: 1, rules } satisfies ForwardRuleStore),
      secureStoreOptions
    );
    return rules;
  };
  return enqueueRuleWrite(operation);
}

function enqueueRuleWrite<Result>(operation: () => Promise<Result>) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function loadForwardRulesNow(profileId: string) {
  const encoded = await SecureStore.getItemAsync(keyForProfile(profileId));
  if (!encoded) return [];
  try {
    const store = JSON.parse(encoded) as ForwardRuleStore;
    return store.version === 1 && Array.isArray(store.rules) ? store.rules : [];
  } catch {
    return [];
  }
}

function sameRule(left: LocalForwardRequest, right: LocalForwardRequest) {
  return left.serverId === right.serverId
    && left.login === right.login
    && left.remoteHost === right.remoteHost
    && left.remotePort === right.remotePort
    && left.localPort === right.localPort;
}
