import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupScope, linkArgs, listBackups, profilePlan, restoreBackup } from '../src/profiles.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/**
 * Every path under `root` (with `/`), with a file's bytes or where a link leads: two equal snapshots mean the
 * same state. A link is compared by the folder it reaches, since Windows restores it as a junction with an absolute target.
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `-> ${relative(root, resolve(dirname(full), readlinkSync(full))).split(sep).join('/')}`;
      else if (st.isDirectory()) {
        out[rel] = 'dir';
        walk(full);
      } else out[rel] = readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

function write(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** A project as the skills CLI leaves it: a canonical copy linked into Claude Code, a home-made skill, a lock. */
function project() {
  const cwd = temp('atlas-profile-');
  write(join(cwd, '.agents/skills/pdf/SKILL.md'), '---\nname: pdf\n---\n');
  write(join(cwd, '.agents/skills/pdf/scripts/run.sh'), 'echo pdf\n');
  mkdirSync(join(cwd, '.claude/skills'), { recursive: true });
  symlinkSync('../../.agents/skills/pdf', join(cwd, '.claude/skills/pdf'));
  write(join(cwd, '.claude/skills/mine/SKILL.md'), '---\nname: mine\n---\nmy own notes\n');
  write(join(cwd, 'skills-lock.json'), '{"version":1,"skills":{"pdf":{"source":"anthropics/skills"}}}\n');
  write(join(cwd, 'src/app.ts'), 'untouched');
  return cwd;
}

const installed = [{ name: 'pdf', source: 'anthropics/skills' }, { name: 'mine' }];

describe('profile backups', () => {
  it('puts a scope back exactly, links, home-made skills and lock included, and can undo that too', () => {
    const cwd = project();
    const root = temp('atlas-backups-');
    const before = snapshot(cwd);
    const backup = backupScope('project', 'profile:design', installed, cwd, root);
    expect(backup).toMatchObject({ scope: 'project', cwd, reason: 'profile:design', initial: true, skills: [{ name: 'pdf', source: 'anthropics/skills' }, { name: 'mine' }] });

    // What a profile does: other skills removed, new ones installed, the lock rewritten, a new agent folder.
    rmSync(join(cwd, '.claude/skills/mine'), { recursive: true });
    rmSync(join(cwd, '.claude/skills/pdf'));
    rmSync(join(cwd, '.agents/skills/pdf'), { recursive: true });
    write(join(cwd, '.agents/skills/figma/SKILL.md'), '---\nname: figma\n---\n');
    write(join(cwd, '.augment/skills/figma/SKILL.md'), 'copy');
    write(join(cwd, 'skills-lock.json'), '{"version":1,"skills":{"figma":{}}}\n');
    const during = snapshot(cwd);

    const undo = restoreBackup(backup.id, [{ name: 'figma', source: 'o/r' }], cwd, root);
    const after = snapshot(cwd);
    // The emptied .augment/skills folder stays; everything else is exactly as before.
    expect(after['.augment/skills']).toBe('dir');
    delete after['.augment'];
    delete after['.augment/skills'];
    expect(after).toEqual(before);
    expect(undo).toMatchObject({ reason: `restore:${backup.id}`, initial: false });

    restoreBackup(undo.id, [], cwd, root);
    expect(snapshot(cwd)).toEqual(during);
  });

  it('removes a lock the backup did not have', () => {
    const cwd = temp('atlas-profile-nolock-');
    write(join(cwd, '.agents/skills/a/SKILL.md'), 'a');
    const root = temp('atlas-backups-');
    const backup = backupScope('project', 'manual', [], cwd, root);
    write(join(cwd, 'skills-lock.json'), '{}');
    restoreBackup(backup.id, [], cwd, root);
    expect(existsSync(join(cwd, 'skills-lock.json'))).toBe(false);
  });

  it('keeps the initial backup and the ten latest, and lists only this project with the global ones', () => {
    const cwd = project();
    const other = project();
    const root = temp('atlas-backups-');
    for (let i = 0; i < 13; i++) backupScope('project', `n${i}`, [], cwd, root, new Date(Date.UTC(2026, 10, 1, 0, 0, i)));
    backupScope('project', 'other', [], other, root);
    const mine = listBackups('project', cwd, root);
    expect(mine).toHaveLength(11);
    expect(mine.at(-1)).toMatchObject({ reason: 'n0', initial: true });
    expect(mine[0]!.reason).toBe('n12');
    expect(listBackups(undefined, other, root).map((b) => b.reason)).toEqual(['other']);
  });

  it('refuses a manifest whose entries would step out of their folder', () => {
    const cwd = project();
    const root = temp('atlas-backups-');
    const backup = backupScope('project', 'manual', [], cwd, root);
    const path = join(root, backup.id, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.dirs[0].entries.push({ kind: 'dir', name: '../../escape' });
    writeFileSync(path, JSON.stringify(manifest));
    expect(listBackups('project', cwd, root)).toEqual([]);
    expect(() => restoreBackup(backup.id, [], cwd, root)).toThrow(`no backup ${backup.id}`);
  });
});

describe('profile plan', () => {
  it('keeps the pack, removes everything else (home-made included) and installs what is missing', () => {
    const plan = profilePlan({ skills: ['Anthropics/skills@pdf', 'figma/skills@figma'] }, [
      { name: 'pdf', source: 'anthropics/skills' },
      { name: 'mine' },
      { name: 'lint', source: 'o/r' },
    ]);
    expect(plan).toEqual({
      keep: ['anthropics/skills@pdf'],
      remove: [{ name: 'mine', id: 'local@mine' }, { name: 'lint', id: 'o/r@lint' }],
      install: ['figma/skills@figma'],
    });
  });
});

describe('links on restore', () => {
  it('keeps a link as it was, and makes a junction with an absolute target on Windows', () => {
    expect(linkArgs('../../.agents/skills/pdf', '/p/.claude/skills/pdf', 'linux')).toEqual(['../../.agents/skills/pdf', '/p/.claude/skills/pdf', 'dir']);
    const [target, , type] = linkArgs('../../.agents/skills/pdf', join('/p', '.claude', 'skills', 'pdf'), 'win32');
    expect(type).toBe('junction');
    expect(target).toBe(resolve('/p', '.agents', 'skills', 'pdf'));
  });
});
