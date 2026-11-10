import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computedFolderHash, findProjectUpdates, readProjectLockedSkills } from '../src/install/updates.js';
import { planUpdates } from '../src/install/plan.js';

const blob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const files = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([p, t]) => [p, Buffer.from(t)]));

/** A project with one installed skill per entry, as the skills CLI leaves it: canonical folder + lock. */
function project(skills: Record<string, { installed: Record<string, string>; lockFiles?: Record<string, string>; ref?: string; source?: string }>) {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-project-'));
  const lock: Record<string, object> = {};
  for (const [name, s] of Object.entries(skills)) {
    const dir = join(cwd, '.agents', 'skills', name);
    for (const [path, text] of Object.entries(s.installed)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    lock[name] = {
      source: s.source ?? 'o/r', sourceType: 'github', skillPath: `skills/${name}/SKILL.md`,
      computedHash: computedFolderHash(files(s.lockFiles ?? s.installed)), ...(s.ref ? { ref: s.ref } : {}),
    };
  }
  writeFileSync(join(cwd, 'skills-lock.json'), JSON.stringify({ version: 1, skills: lock }));
  return cwd;
}

const tree = (entries: Record<string, string>) =>
  Response.json({ sha: 'root', tree: Object.entries(entries).map(([path, text]) => ({ path, type: 'blob', sha: blob(text) })) });

let cwd: string | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = undefined;
});

describe('project skill updates', () => {
  it('hashes a folder the way the skills CLI writes computedHash', () => {
    // SHA-256 of each path then its bytes, in localeCompare order (`ref/` before `SKILL.md`); node_modules and .git are left out.
    const expected = createHash('sha256').update('ref/x.md').update('x').update('SKILL.md').update('# a').digest('hex');
    expect(computedFolderHash(files({ 'ref/x.md': 'x', 'SKILL.md': '# a', 'node_modules/p/i.js': 'no' }))).toBe(expected);
  });

  it('reads the checkable GitHub skills of the project lock, never a pinned one', () => {
    cwd = project({ a: { installed: { 'SKILL.md': '# a' } }, pinned: { installed: { 'SKILL.md': '# p' }, ref: 'a'.repeat(40) } });
    expect(readProjectLockedSkills(join(cwd, 'skills-lock.json')).map((s) => `${s.name}:${s.dir}`)).toEqual(['a:skills/a']);
  });

  it('flags a changed skill, keeps an identical one, and never overwrites one edited by hand', async () => {
    cwd = project({
      same: { installed: { 'SKILL.md': '# same', 'scripts/run.sh': 'echo' } },
      newer: { installed: { 'SKILL.md': '# v1' } },
      edited: { installed: { 'SKILL.md': '# v1 with my notes' }, lockFiles: { 'SKILL.md': '# v1' } },
    });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return tree({
        'skills/same/SKILL.md': '# same', 'skills/same/scripts/run.sh': 'echo', 'skills/same/metadata.json': '{}',
        'skills/newer/SKILL.md': '# v2',
        'skills/edited/SKILL.md': '# v2',
      });
    });
    const found = await findProjectUpdates(cwd, 'token');
    expect([...found.outdated]).toEqual(['o/r@newer']);
    expect(found.modified).toEqual(['o/r@edited']);
    expect(found.unchecked).toEqual([]);
    // One Trees call for the repository the three skills share.
    expect(calls).toEqual(['https://api.github.com/repos/o/r/git/trees/HEAD?recursive=1']);
  });

  it('reports what it could not check instead of calling it up to date', async () => {
    cwd = project({ gone: { installed: { 'SKILL.md': '# g' } }, other: { installed: { 'SKILL.md': '# o' }, source: 'down/repo' } });
    vi.stubGlobal('fetch', async (url: string) => (url.includes('down/repo') ? new Response('', { status: 403 }) : tree({ 'README.md': 'x' })));
    const found = await findProjectUpdates(cwd, 'token');
    expect(found.outdated.size).toBe(0);
    expect(found.unchecked).toEqual(expect.arrayContaining([
      { source: 'down/repo', reason: 'HTTP 403' },
      { source: 'o/r', reason: 'gone: skills/gone not found' },
    ]));
  });

  it('reinstalls a project update in the project, without -g', () => {
    const commands = planUpdates(
      [{ id: 'o/r@a', agents: ['claude-code'], scope: 'project' }, { id: 'o/r@b', agents: ['claude-code'] }],
      { agents: [], scope: 'global', method: 'symlink', skillsVersion: '1.7.0' },
    );
    expect(commands.map((c) => [c.scope, c.args.includes('-g'), c.skills])).toEqual([['project', false, ['a']], ['global', true, ['b']]]);
  });
});
