import greenhouse from './greenhouse.mjs';
import lever from './lever.mjs';
import staticSite from './static.mjs';
import workday from './workday.mjs';

const ADAPTERS = new Map([
  [greenhouse.id, greenhouse],
  [lever.id, lever],
  [staticSite.id, staticSite],
  [workday.id, workday],
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
