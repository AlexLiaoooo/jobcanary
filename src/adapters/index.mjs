import greenhouse from './greenhouse.mjs';

const ADAPTERS = new Map([
  [greenhouse.id, greenhouse],
]);

export function getAdapter(type) {
  const adapter = ADAPTERS.get(type);
  if (!adapter) {
    throw new Error(
      `unknown adapter type '${type}' — known types: ${listAdapterTypes().join(', ')}`
    );
  }
  return adapter;
}

export function listAdapterTypes() {
  return [...ADAPTERS.keys()].sort();
}

export function registerAdapter(adapter) {
  ADAPTERS.set(adapter.id, adapter);
}
