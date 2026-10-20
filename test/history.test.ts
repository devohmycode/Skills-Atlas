import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropRevision, installedRevision, pushRevision, readHistory, recordBeforeUpdate } from '../src/install/history.js';

const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const tmp = () => mkdtempSync(join(tmpdir(), 'atlas-history-'));

afterEach(() => vi.unstubAllGlobals());

describe('update history', () => {
  it('keeps the last five versions per skill, newest last, and forgets one reinstalled', () => {
    const path = join(tmp(), 'history.json');
    for (let i = 1; i <= 7; i++) pushRevision('O/R@X', sha(i), path, new Date(Date.UTC(2026, 0, i)));
    pushRevision('o/r@x', sha(5), path);
    expect(readHistory(path)['o/r@x']!.map((r) => r.revision)).toEqual([sha(3), sha(4), sha(6), sha(7), sha(5)]);
    dropRevision('o/r@x', sha(5), path);
    expect(readHistory(path)['o/r@x']!.at(-1)!.revision).toBe(sha(7));
    expect(() => pushRevision('o/r@x', 'main', path)).toThrow();
  });

  it('records the installed version of each updated skill from the lock, and names the ones it cannot find', async () => {
    const dir = tmp();
    const lock = join(dir, 'lock.json');
    writeFileSync(lock, JSON.stringify({ skills: {
      x: { source: 'o/r', sourceType: 'github', skillPath: 'skills/x/SKILL.md', skillFolderHash: 'h', updatedAt: '2026-10-01T00:00:00Z' },
      y: { source: 'o/r', sourceType: 'github', skillPath: 'skills/y/SKILL.md', skillFolderHash: 'h' },
    } }));
    const path = join(dir, 'history.json');
    const missed = await recordBeforeUpdate(['o/r@x', 'o/r@y', 'a/b@z'], lock, path, async (s) => (s.date ? sha(9) : undefined));
    expect(missed).toEqual(['o/r@y', 'a/b@z']);
    expect(Object.keys(readHistory(path))).toEqual(['o/r@x']);
  });

  it('asks GitHub for the last commit touching the folder before the install date', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { urls.push(url); return Response.json([{ sha: sha(4) }]); });
    expect(await installedRevision({ name: 'x', source: 'o/r', dir: 'skills/x', hash: 'h', date: '2026-10-01T00:00:00Z' }, '')).toBe(sha(4));
    expect(urls[0]).toBe('https://api.github.com/repos/o/r/commits?until=2026-10-01T00%3A00%3A00Z&per_page=1&path=skills%2Fx');
    expect(await installedRevision({ name: 'x', source: 'o/r', dir: 'x', hash: 'h' })).toBeUndefined();
  });
});
