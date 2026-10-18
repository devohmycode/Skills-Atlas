import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

it('lock, pinned audit/dry-run and sync check work through the CLI', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-revision-cli-'));
  const sha = 'a'.repeat(40), old = 'b'.repeat(40);
  const content = '---\nname: x\n---\nsafe';
  const hash = 'dd7f83f200fedee4660c3ebb83bfe189876f00ae'; // git hash-object --stdin
  const preload = join(cwd, 'fetch.mjs');
  writeFileSync(preload, `globalThis.fetch = async url => {
    if (url === 'https://api.github.com/repos/o/r/commits/HEAD') return Response.json({sha: '${sha}'});
    if (url === 'https://api.github.com/repos/o/r/git/trees/${sha}?recursive=1') return Response.json({ truncated: false, tree: [{path:'skills/x/SKILL.md',type:'blob',mode:'100644',sha:'${hash}'}] });
    if (url === 'https://raw.githubusercontent.com/o/r/${sha}/skills/x/SKILL.md') return new Response(${JSON.stringify(content)});
    throw Error('unexpected fetch ' + url);
  };`);
  const path = join(cwd, 'skills-atlas.json');
  const original = JSON.stringify({ skillsAtlas: 1, skills: ['o/r@x'], agents: ['codex'], revisions: { 'o/r@x': old } });
  writeFileSync(path, original);
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), ...args], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(cwd, 'config') },
  });
  try {
    expect(run('lock', '--dry-run')).toContain(`https://github.com/o/r/compare/${old}...${sha}`);
    expect(readFileSync(path, 'utf8')).toBe(original);
    run('lock'); expect(JSON.parse(readFileSync(path, 'utf8')).revisions['o/r@x']).toBe(sha);
    expect(run('sync', '--dry-run', '-y')).toContain(`https://github.com/o/r/tree/${sha}`);
    const dir = join(cwd, '.agents', 'skills', 'x'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), content);
    writeFileSync(join(cwd, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { x: { source: 'o/r', sourceType: 'github', ref: sha, skillPath: 'skills/x/SKILL.md' } } }));
    expect(run('sync', '--check')).toContain('All 1 skill');
    writeFileSync(join(dir, 'SKILL.md'), content + ' drift');
    expect(() => run('sync', '--check')).toThrow();
    expect(run('__complete', '--', 'lo')).toContain('lock');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);
