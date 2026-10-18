import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSelectionFile } from '../src/selection.js';
import { planInstall } from '../src/install/plan.js';
import { fetchSkillMarkdown } from '../src/github.js';
import { lockSelection, revisionChanges, verifyRevision } from '../src/revisions.js';
const sha = 'a'.repeat(40), next = 'b'.repeat(40);
const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'atlas-revision-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hashes: Record<string, string> = { safe: 'b9f5b7439c5d270594d262ba47697bc17dcdc741', 'print(1)': 'b41e3eea2e49488dd0f1b80fec905c6c1e77205f' }; // git hash-object --stdin
it('preserves old manifests and validates pins and their member ids', () => {
  expect(parseSelectionFile('{"skillsAtlas":1,"skills":["o/r@x"]}').revisions).toBeUndefined();
  expect(parseSelectionFile(JSON.stringify({ skillsAtlas: 1, skills: ['o/r@x'], revisions: { 'O/R@X': sha.toUpperCase() } })).revisions).toEqual({ 'o/r@x': sha });
  for (const revisions of [{ 'o/r@x': 'main' }, { 'o/r@y': sha }, { 'o/r@x': sha.slice(1) }, { 'o/r@x': 42 }])
    expect(() => parseSelectionFile(JSON.stringify({ skillsAtlas: 1, skills: ['o/r@x'], revisions }))).toThrow();
  for (const id of ['../r@x', 'o/..@x', '-o/r@x']) expect(() => parseSelectionFile(JSON.stringify({ skillsAtlas: 1, skills: [id] }))).toThrow();
});
it('groups by exact revision using supported GitHub tree syntax', () => {
  const options = { agents: ['codex'], scope: 'project' as const, method: 'copy' as const, skillsVersion: '1.7.0' };
  const commands = planInstall(['o/r@x', 'o/r@y', 'o/r@z'], options, { 'o/r@x': sha, 'o/r@y': sha, 'o/r@z': next });
  expect(commands.map(c => c.args.slice(3))).toEqual([
    [`https://github.com/o/r/tree/${sha}`, '-s', 'x', 'y', '-a', 'codex', '--copy', '-y', '--json'],
    [`https://github.com/o/r/tree/${next}`, '-s', 'z', '-a', 'codex', '--copy', '-y', '--json'],
  ]);
  expect(() => planInstall(['o/r@x'], options, { 'o/r@x': 'main' })).toThrow();
});
it('locks each repository once, preserves fields and offers compare links', async () => {
  const path = join(fixture(), 'skills-atlas.json');
  writeFileSync(path, JSON.stringify({ skillsAtlas: 1, skills: ['o/r@x', 'O/R@y'], agents: ['codex'], note: 'keep', revisions: { 'o/r@x': sha } }));
  let resolutions = 0;
  const changes = await lockSelection(path, false, async source => { expect(source).toBe('o/r'); resolutions++; return next; });
  expect(resolutions).toBe(1);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ note: 'keep', agents: ['codex'], revisions: { 'o/r@x': next, 'O/R@y': next } });
  expect(changes[0]).toEqual({ id: 'o/r@x', previous: sha, revision: next, compare: `https://github.com/o/r/compare/${sha}...${next}` });
  expect(revisionChanges(['o/r@x'], { 'o/r@x': sha }, { 'o/r@x': sha })[0]?.compare).toBeUndefined();
});
it('never writes on dry-run, invalid resolution, or partial failure', async () => {
  const path = join(fixture(), 'skills-atlas.json');
  const original = '{"skillsAtlas":1,"skills":["o/r@x","p/q@y"]}'; writeFileSync(path, original);
  await lockSelection(path, true, async () => sha);
  expect(readFileSync(path, 'utf8')).toBe(original);
  await expect(lockSelection(path, false, async source => { if (source === 'p/q') throw Error('offline'); return sha; })).rejects.toThrow('offline');
  expect(readFileSync(path, 'utf8')).toBe(original);
  await expect(lockSelection(path, false, async () => 'main')).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe(original);
});
it('reads audit markdown from the pinned ref and rejects invalid refs', async () => {
  vi.stubGlobal('fetch', async (url: string) => { expect(url).toBe(`https://raw.githubusercontent.com/o/r/${sha}/skills/x/SKILL.md`); return new Response('safe'); });
  expect(await fetchSkillMarkdown({ source: 'o/r', name: 'x', path: 'skills/x' }, sha)).toBe('safe');
  await expect(fetchSkillMarkdown({ source: 'o/r', name: 'x' }, 'HEAD')).rejects.toThrow();
});
it('verifies every installed byte against the pinned Git tree and detects drift', async () => {
  const dir = fixture(); mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'SKILL.md'), 'safe'); writeFileSync(join(dir, 'scripts', 'run.py'), 'print(1)');
  const tree = { truncated: false, tree: [
    { path: 'skills/x/SKILL.md', type: 'blob', mode: '100644', sha: hashes.safe! },
    { path: 'skills/x/scripts/run.py', type: 'blob', mode: '100644', sha: hashes['print(1)']! },
  ] };
  vi.stubGlobal('fetch', async (url: string) => { expect(url).toBe(`https://api.github.com/repos/o/r/git/trees/${sha}?recursive=1`); return Response.json(tree); });
  expect(await verifyRevision('o/r@x', sha, 'skills/x/SKILL.md', [dir])).toBe(true);
  writeFileSync(join(dir, 'scripts', 'run.py'), 'print(2)');
  expect(await verifyRevision('o/r@x', sha, 'skills/x/SKILL.md', [dir])).toBe(false);
  writeFileSync(join(dir, 'scripts', 'run.py'), 'print(1)'); writeFileSync(join(dir, 'extra'), 'drift');
  expect(await verifyRevision('o/r@x', sha, 'skills/x/SKILL.md', [dir])).toBe(false);
  await expect(verifyRevision('o/r@x', sha, '../SKILL.md', [dir])).rejects.toThrow();
  tree.truncated = true;
  await expect(verifyRevision('o/r@x', sha, 'skills/x/SKILL.md', [dir])).rejects.toThrow(/verif/i);
});

it('checks all project copies, lock ref and content rather than skill presence', async () => {
  const { projectRevisionDrift } = await import('../src/revisions.js');
  const { scanInstalled } = await import('../src/install/scan.js');
  const cwd = fixture();
  const canonical = join(cwd, '.agents', 'skills', 'x'), copy = join(cwd, '.claude', 'skills', 'x');
  mkdirSync(canonical, { recursive: true }); mkdirSync(copy, { recursive: true });
  writeFileSync(join(canonical, 'SKILL.md'), 'safe'); writeFileSync(join(copy, 'SKILL.md'), 'safe');
  const lock = { version: 1, skills: { x: { source: 'o/r', sourceType: 'github', ref: sha, skillPath: 'skills/x/SKILL.md', computedHash: 'unused' } } };
  const save = () => writeFileSync(join(cwd, 'skills-lock.json'), JSON.stringify(lock)); save();
  vi.stubGlobal('fetch', async () => Response.json({ truncated: false, tree: [{ path: 'skills/x/SKILL.md', mode: '100644', type: 'blob', sha: hashes.safe! }] }));
  const check = () => projectRevisionDrift(['o/r@x'], { 'o/r@x': sha }, scanInstalled('project', cwd), cwd);
  expect(await check()).toEqual([]);
  writeFileSync(join(copy, 'SKILL.md'), 'edited'); expect(await check()).toEqual(['o/r@x']);
  writeFileSync(join(copy, 'SKILL.md'), 'safe'); lock.skills.x.ref = next; save(); expect(await check()).toEqual(['o/r@x']);
  lock.skills.x.ref = sha; lock.skills.x.skillPath = ''; save();
  await expect(check()).rejects.toThrow(/verif/i);
});

it('rejects pinned audit paths that could escape the immutable ref', async () => {
  vi.stubGlobal('fetch', async () => new Response('unsafe fallback'));
  for (const path of ['../../HEAD/skills/x', 'skills/x?ref=HEAD', 'skills/x#HEAD'])
    await expect(fetchSkillMarkdown({ source: 'o/r', name: 'x', path }, sha)).rejects.toThrow(/path/);
});

it('keeps dot-prefixed repository names installable', () => {
  expect(parseSelectionFile('{\"skillsAtlas\":1,\"skills\":[\"o/.github@x\"]}').ids).toEqual(['o/.github@x']);
});

it('produces a valid lock when legacy manifests repeat an id with different casing', async () => {
  const path = join(fixture(), 'skills-atlas.json');
  writeFileSync(path, JSON.stringify({ skillsAtlas: 1, skills: ['o/r@x', 'O/R@X'] }));
  await lockSelection(path, false, async () => sha);
  expect(Object.values(parseSelectionFile(readFileSync(path, 'utf8')).revisions!)).toEqual([sha]);
});

it('forces LF checkout only for pinned add commands, after existing Git config entries', async () => {
  const { commandEnv } = await import('../src/install/run.js');
  const options = { agents: ['codex'], scope: 'project' as const, method: 'copy' as const, skillsVersion: '1.7.0' };
  const [pinned] = planInstall(['o/r@x'], options, { 'o/r@x': sha });
  const [unpinned] = planInstall(['o/r@x'], options);
  const base = { PATH: 'p', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' };
  expect(commandEnv(pinned!, base)).toEqual({ ...base, FORCE_COLOR: '0', GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'core.eol', GIT_CONFIG_VALUE_2: 'lf' });
  expect(commandEnv(pinned!, { PATH: 'p' })).toEqual({ PATH: 'p', FORCE_COLOR: '0', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.eol', GIT_CONFIG_VALUE_1: 'lf' });
  expect(commandEnv(unpinned!, base)).toEqual({ ...base, FORCE_COLOR: '0' });
});

it('keeps LF bytes when the user Git configuration enables autocrlf', async () => {
  const { execFileSync } = await import('node:child_process');
  const { commandEnv } = await import('../src/install/run.js');
  const [pinned] = planInstall(['o/r@x'], { agents: ['codex'], scope: 'project', method: 'copy', skillsVersion: '1.7.0' }, { 'o/r@x': sha });
  const repo = fixture();
  const user = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' };
  const git = (env: NodeJS.ProcessEnv, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' });
  git(user, 'init', '-q'); writeFileSync(join(repo, 'SKILL.md'), 'a\nb\n'); git(user, 'add', 'SKILL.md');
  rmSync(join(repo, 'SKILL.md')); git(user, 'checkout', '--', 'SKILL.md');
  expect(readFileSync(join(repo, 'SKILL.md'), 'utf8')).toBe('a\r\nb\r\n');
  rmSync(join(repo, 'SKILL.md')); git(commandEnv(pinned!, user), 'checkout', '--', 'SKILL.md');
  expect(readFileSync(join(repo, 'SKILL.md'), 'utf8')).toBe('a\nb\n');
});

it('verifies a copy named after the skill even when its SKILL.md is renamed or missing', async () => {
  const { projectRevisionDrift } = await import('../src/revisions.js');
  const { scanInstalled } = await import('../src/install/scan.js');
  const cwd = fixture();
  const canonical = join(cwd, '.agents', 'skills', 'x'), copy = join(cwd, '.claude', 'skills', 'x');
  mkdirSync(canonical, { recursive: true }); mkdirSync(copy, { recursive: true });
  writeFileSync(join(canonical, 'SKILL.md'), 'safe');
  writeFileSync(join(cwd, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { x: { source: 'o/r', ref: sha, skillPath: 'skills/x/SKILL.md' } } }));
  vi.stubGlobal('fetch', async () => Response.json({ truncated: false, tree: [{ path: 'skills/x/SKILL.md', mode: '100644', type: 'blob', sha: hashes.safe! }] }));
  const check = () => projectRevisionDrift(['o/r@x'], { 'o/r@x': sha }, scanInstalled('project', cwd), cwd);
  writeFileSync(join(copy, 'SKILL.md'), '---\nname: renamed\n---\nedited');
  expect(await check()).toEqual(['o/r@x']);
  rmSync(join(copy, 'SKILL.md'));
  expect(await check()).toEqual(['o/r@x']);
  rmSync(copy, { recursive: true });
  expect(await check()).toEqual([]);
});
