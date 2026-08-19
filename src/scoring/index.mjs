import none from './none.mjs';

const PROVIDERS = new Map([[none.id, none]]);

export function getProvider(id) {
  const provider = PROVIDERS.get(id);
  if (!provider) {
    throw new Error(
      `unknown scoring provider '${id}' — known providers: ${[...PROVIDERS.keys()].sort().join(', ')}`
    );
  }
  return provider;
}

export function registerProvider(provider) {
  PROVIDERS.set(provider.id, provider);
}
