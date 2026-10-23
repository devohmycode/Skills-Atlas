import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { findUpdates, outdated, readLockedSkills } from '../src/install/updates.js';

const lock = {
  version: 3,
  skills: {
    ponytail: { source: 'DietrichGebert/ponytail', sourceType: 'github', skillPath: 'skills/ponytail/SKILL.md', skillFolderHash: 'old' },
    pdf: { source: 'anthropics/skills', sourceType: 'github', skillPath: 'skills/pdf/SKILL.md', skillFolderHash: 'same' },
    local: { source: 'C:/mine', sourceType: 'local', skillPath: 'SKILL.md', skillFolderHash: 'x' },
    project: { source: 'a/b', sourceType: 'github', skillPath: 'skills/x/SKILL.md', computedHash: 'sha256' },
  },
};

describe('skill updates', () => {
  it('reads the GitHub skills whose folder hash the lock recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-lock-'));
    try {
      writeFileSync(join(dir, 'lock.json'), JSON.stringify(lock));
      expect(readLockedSkills(join(dir, 'lock.json')).map((s) => `${s.name}:${s.dir}`)).toEqual(['ponytail:skills/ponytail', 'pdf:skills/pdf']);
      expect(readLockedSkills(join(dir, 'missing.json'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a skill whose folder changed, never one it could not check', () => {
    const skills = [
      { name: 'ponytail', source: 'DietrichGebert/ponytail', dir: 'skills/ponytail', hash: 'old' },
      { name: 'pdf', source: 'anthropics/skills', dir: 'skills/pdf', hash: 'same' },
      { name: 'gone', source: 'anthropics/skills', dir: 'skills/gone', hash: 'h' },
      { name: 'x', source: 'offline/repo', dir: 'x', hash: 'h' },
    ];
    const trees = new Map([
      ['DietrichGebert/ponytail', new Map([['skills/ponytail', 'new']])],
      ['anthropics/skills', new Map([['skills/pdf', 'same']])],
    ]);
    expect([...outdated(skills, trees)]).toEqual(['dietrichgebert/ponytail@ponytail']);
  });

  const check = async (answer: (url: string) => Response | Promise<Response>, skills: object = lock.skills) => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-lock-'));
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { calls.push(url); return answer(url); });
    try {
      writeFileSync(join(dir, 'lock.json'), JSON.stringify({ ...lock, skills }));
      const found = await findUpdates(join(dir, 'lock.json'), 'secret-token');
      return { outdated: [...found.outdated], unchecked: found.unchecked, calls };
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const tree = (...entries: [string, string][]) => Response.json({ sha: 'root', tree: entries.map(([path, sha]) => ({ path, type: 'tree', sha })) });

  it('asks GitHub once per repository, keeps the confirmed updates, and reports one it could not read', async () => {
    const got = await check((url) => (url.includes('anthropics') ? new Response('', { status: 403 }) : tree(['skills/ponytail', 'new'])));
    expect(got.outdated).toEqual(['dietrichgebert/ponytail@ponytail']);
    expect(got.unchecked).toEqual([{ source: 'anthropics/skills', reason: 'HTTP 403' }]);
    expect(got.calls).toHaveLength(2);
    expect(JSON.stringify(got.unchecked)).not.toContain('secret-token');
  });

  it('never reads a failed, invalid, truncated or incomplete answer as up to date', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect((await check(() => { throw timeout; })).unchecked.map((u) => u.reason)).toEqual(['timed out', 'timed out']);
    expect((await check(() => new Response('<html>'))).unchecked.map((u) => u.reason)).toEqual(['invalid response', 'invalid response']);
    expect((await check(() => Response.json({ tree: [] }))).unchecked.map((u) => u.reason)).toEqual(['invalid response', 'invalid response']);
    const truncated = await check(() => Response.json({ sha: 'root', truncated: true, tree: [] }));
    expect(truncated.outdated).toEqual([]);
    expect(truncated.unchecked.map((u) => u.reason)).toEqual(['ponytail: tree truncated', 'pdf: tree truncated']);
    const moved = await check(() => tree(['skills/pdf', 'same']));
    expect(moved.unchecked).toEqual([{ source: 'DietrichGebert/ponytail', reason: 'ponytail: skills/ponytail not found' }]);
  });

  it('checks a skill at the repository root against the root tree', async () => {
    const root = { r: { source: 'o/r', sourceType: 'github', skillPath: 'SKILL.md', skillFolderHash: 'old' } };
    expect(await check(() => tree(), root)).toMatchObject({ outdated: ['o/r@r'], unchecked: [] });
    expect((await check(() => Response.json({ sha: 'old', tree: [] }), root)).outdated).toEqual([]);
  });
});
