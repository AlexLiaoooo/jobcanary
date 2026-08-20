const DEFAULT_UA =
  'Mozilla/5.0 (compatible; jobcanary/0.1; +https://github.com/AlexLiaoooo/jobcanary)';

/**
 * Build the injectable fetch used by every adapter. Adapters never touch the
 * global fetch, so tests can substitute a stub without a network.
 */
export function createHttp({ timeoutMs = 25_000, userAgent = DEFAULT_UA } = {}) {
  return async function http(url, { method = 'GET', body = null, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          'Accept-Language': 'en-GB,en;q=0.9',
          ...headers,
        },
      });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}
