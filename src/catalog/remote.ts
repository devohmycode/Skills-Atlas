import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Catalog } from '../types.js';
import { decodeCatalog, defaultCatalogPath } from './load.js';

/** Snapshot refreshed every other day by the crawl workflow. */
export const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/devohmycode/Skills-Atlas/main/data/catalog.json.gz';
/** How long a downloaded catalog is used before asking GitHub again. */
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** After a failed download, wait this long before trying again. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  return join(base, 'skills-atlas');
}

interface CacheMeta {
  etag?: string;
  /** Last time GitHub was asked, successfully or not (ms). */
  checkedAt: number;
}

export interface LatestOptions {
  /** Never download: use the cache or the bundled snapshot. */
  offline?: boolean;
  /** Ask GitHub now, however recent the cache (the ETag still avoids a needless download). */
  refresh?: boolean;
  /** Called when the download fails; the cache or the bundled snapshot is used anyway. */
  onError?: (err: unknown) => void;
  /** Called before a download starts, e.g. to tell the user. */
  onDownload?: () => void;
  bundledPath?: string;
  dir?: string;
  url?: string;
  now?: number;
  fetch?: typeof fetch;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function tryDecode(path: string): Catalog | undefined {
  try {
    return existsSync(path) ? decodeCatalog(readFileSync(path)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The most recent catalog available: the one downloaded from GitHub (cached
 * for `MAX_AGE_MS`, revalidated with its ETag) or the snapshot bundled in the
 * package, whichever was generated last. A failed download is never fatal:
 * the cache or the bundled snapshot is used instead.
 */
export async function loadLatestCatalog(opts: LatestOptions = {}): Promise<Catalog> {
  const dir = opts.dir ?? cacheDir();
  const file = join(dir, 'catalog.json.gz');
  const metaFile = join(dir, 'catalog.meta.json');
  const now = opts.now ?? Date.now();
  const doFetch = opts.fetch ?? fetch;

  let cached = tryDecode(file);
  const meta = readJson<CacheMeta>(metaFile);
  const writeMeta = (m: CacheMeta) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(metaFile, `${JSON.stringify(m)}\n`);
    } catch {
      // A read-only cache only means downloading again next time.
    }
  };

  // A cache file that vanished while its ETag is known is fetched again at once;
  // after a failed download (no ETag), the retry delay applies.
  const stale = opts.refresh || !meta || now - meta.checkedAt >= MAX_AGE_MS || (!cached && meta.etag !== undefined);
  if (!opts.offline && stale) {
    opts.onDownload?.();
    try {
      const res = await doFetch(opts.url ?? REMOTE_CATALOG_URL, {
        headers: cached && meta?.etag ? { 'if-none-match': meta.etag } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 304 && cached) {
        writeMeta({ etag: meta?.etag, checkedAt: now });
      } else if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const fresh = decodeCatalog(buf);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, buf);
        writeMeta({ etag: res.headers.get('etag') ?? undefined, checkedAt: now });
        cached = fresh;
      } else throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Offline, GitHub down or a bad file: try again in an hour, not on every run.
      writeMeta({ etag: meta?.etag, checkedAt: now - MAX_AGE_MS + RETRY_AFTER_MS });
      opts.onError?.(err);
    }
  }

  const bundled = tryDecode(opts.bundledPath ?? defaultCatalogPath());
  const newest = [cached, bundled]
    .filter((c): c is Catalog => c !== undefined)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  if (!newest) throw new Error('no catalog available — check your connection or pass --catalog <path|url>');
  return newest;
}
