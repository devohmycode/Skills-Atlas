import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNewer, newerVersion, refreshLatest } from '../src/version.js';

describe('new version notice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-version-'));
  const path = join(dir, 'latest.json');
  afterEach(() => vi.unstubAllGlobals());

  it('compares released versions only', () => {
    expect(isNewer('0.8.1', '0.8.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.8.0', '0.8.0')).toBe(false);
    expect(isNewer('0.7.9', '0.8.0')).toBe(false);
    expect(isNewer('1.0.0-beta.1', '0.8.0')).toBe(false);
    expect(isNewer('<script>', '0.8.0')).toBe(false);
  });

  it('answers from the cache at once and refreshes it only once a day', () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    writeFileSync(path, JSON.stringify({ version: '0.9.0', checkedAt: 1000 }));
    expect(newerVersion('0.8.0', { path, now: 2000 })).toBe('0.9.0');
    expect(newerVersion('0.9.0', { path, now: 2000 })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(newerVersion('0.8.0', { path, now: 1000 + 25 * 3600_000 })).toBe('0.9.0');
    expect(fetch).toHaveBeenCalledOnce();
    expect(newerVersion('0.8.0', { path, now: 1000 + 25 * 3600_000, offline: true })).toBe('0.9.0');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('remembers what npm said, or that it could not be reached', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ version: '1.2.3' })));
    expect(await refreshLatest(path)).toBe('1.2.3');
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe('1.2.3');
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    expect(await refreshLatest(path)).toBeUndefined();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ checkedAt: expect.any(Number) });
    rmSync(dir, { recursive: true, force: true });
  });
});
