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

  it('asks GitHub once per repository and survives one that fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-lock-'));
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.includes('anthropics')) return new Response('', { status: 404 });
      return new Response(JSON.stringify({ tree: [{ path: 'skills/ponytail', type: 'tree', sha: 'new' }] }));
    });
    try {
      writeFileSync(join(dir, 'lock.json'), JSON.stringify(lock));
      expect([...(await findUpdates(join(dir, 'lock.json'), 'token'))]).toEqual(['dietrichgebert/ponytail@ponytail']);
      expect(calls).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
