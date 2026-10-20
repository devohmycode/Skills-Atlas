const USER_AGENT = 'skills-atlas-crawler (+https://github.com/devohmycode/Skills-Atlas)';

export interface FetchOptions {
  retries?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET with timeout and exponential backoff on network errors, 429 and 5xx.
 * Honours `Retry-After` when the server sends one.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const retries = opts.retries ?? 4;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/xml, */*', ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (res.ok) return await res.text();
      if (res.status !== 429 && res.status < 500) throw new HttpError(url, res.status);
      const retryAfter = Number(res.headers.get('retry-after'));
      lastError = new HttpError(url, res.status);
      if (attempt === retries) break;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      lastError = err;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function fetchJson<T = unknown>(url: string, opts?: FetchOptions): Promise<T> {
  return JSON.parse(await fetchText(url, opts)) as T;
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}
