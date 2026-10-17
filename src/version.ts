import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cacheDir } from './catalog/remote.js';

const LATEST_URL = 'https://registry.npmjs.org/skills-atlas/latest';
/** npm is asked at most once a day. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Latest {
  version?: string;
  checkedAt: number;
}

export const latestPath = () => join(cacheDir(), 'latest-version.json');

/** True when `a` is a later `x.y.z` than `b`; anything else (pre-releases, garbage) is never newer. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : undefined);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

function readLatest(path: string): Latest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Latest;
  } catch {
    return undefined;
  }
}

/** Asks npm for the latest version and remembers it, failure included, so as not to ask again before a day. */
export async function refreshLatest(path = latestPath()): Promise<string | undefined> {
  let version: string | undefined;
  try {
    const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) version = ((await res.json()) as { version?: unknown }).version as string | undefined;
  } catch {
    // Offline or npm unreachable: try again tomorrow.
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: typeof version === 'string' ? version : undefined, checkedAt: Date.now() }));
  } catch {
    // An unwritable cache only means asking again next time.
  }
  return version;
}

/**
 * A later published version than `current`, from what npm said last time.
 * Never waits for the network: a stale answer is refreshed in the background,
 * for the next run, which suits npx caching an old version for a while.
 */
export function newerVersion(current: string, opts: { offline?: boolean; path?: string; now?: number } = {}): string | undefined {
  const path = opts.path ?? latestPath();
  const latest = readLatest(path);
  if (!opts.offline && (!latest || (opts.now ?? Date.now()) - latest.checkedAt > MAX_AGE_MS)) void refreshLatest(path);
  return latest?.version && isNewer(latest.version, current) ? latest.version : undefined;
}
