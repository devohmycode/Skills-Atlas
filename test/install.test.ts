import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAgents, expandHome, unknownAgents } from '../src/agents.js';
import { formatCommand, parseSkillId, planInstall, planRemove, planRemovals } from '../src/install/plan.js';
import { isSuccess, parseResults, phaseOf } from '../src/install/run.js';
import { barFraction } from '../src/ui/Progress.js';
import { frontmatterName, lockPath, readLockSources, scanInstalled } from '../src/install/scan.js';
import type { InstallOptions } from '../src/types.js';

const base: InstallOptions = { agents: ['claude-code'], scope: 'project', method: 'symlink', skillsVersion: '1.7.0' };

describe('parseSkillId', () => {
  it('splits owner/repo@skill', () => {
    expect(parseSkillId('anthropics/skills@pdf')).toEqual({ source: 'anthropics/skills', name: 'pdf' });
  });
  it('rejects malformed ids', () => {
    expect(() => parseSkillId('anthropics/skills')).toThrow();
    expect(() => parseSkillId('pdf@')).toThrow();
    expect(() => parseSkillId('a/b/c@x')).toThrow();
  });
});

describe('planInstall', () => {
  it('groups skills by repository, source first, -a always present', () => {
    const cmds = planInstall(['anthropics/skills@pdf', 'supabase/agent-skills@supabase', 'anthropics/skills@docx'], base);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]!.args).toEqual([
      '-y', 'skills@1.7.0', 'add', 'anthropics/skills', '-s', 'pdf', 'docx', '-a', 'claude-code', '-y', '--json',
    ]);
    expect(cmds[1]!.skills).toEqual(['supabase']);
  });

  it('adds -g and --copy when asked', () => {
    const [cmd] = planInstall(['o/r@x'], { ...base, agents: ['cursor', 'codex'], scope: 'global', method: 'copy' });
    expect(cmd!.args.slice(3)).toEqual(['o/r', '-s', 'x', '-a', 'cursor', 'codex', '-g', '--copy', '-y', '--json']);
  });

  it('never builds a command without agents', () => {
    expect(() => planInstall(['o/r@x'], { ...base, agents: [] })).toThrow(/agent/);
  });

  it('deduplicates repeated skills', () => {
    expect(planInstall(['o/r@x', 'o/r@x'], base)[0]!.skills).toEqual(['x']);
  });

  it('formats commands with quoting', () => {
    const [cmd] = planInstall(['o/r@x'], { ...base, agents: ['*'] });
    expect(formatCommand(cmd!)).toBe('npx -y skills@1.7.0 add o/r -s x -a * -y --json');
  });
});

describe('agents', () => {
  it('validates ids against the skills CLI list', () => {
    expect(unknownAgents(['claude-code', 'cursor', '*'])).toEqual([]);
    expect(unknownAgents(['claude-code', 'nope'])).toEqual(['nope']);
  });
  it('detects agents from their config directory', () => {
    const found = detectAgents((p) => /[\\/]\.claude$/.test(p)).map((a) => a.id);
    expect(found).toContain('claude-code');
    expect(found).not.toContain('cursor');
  });
});

describe('results', () => {
  it('parses the --json array even after stray output', () => {
    const out = 'npm warn something\n[{"name":"pdf","status":"installed","agents":["claude-code"]}]\n';
    expect(parseResults(out)).toEqual([{ name: 'pdf', status: 'installed', agents: ['claude-code'] }]);
    expect(parseResults('garbage')).toEqual([]);
  });

  it('treats skipped or failed entries as failure', () => {
    const command = { kind: 'add' as const, source: 'o/r', skills: ['x'], args: [], scope: 'project' as const };
    expect(isSuccess({ command, exitCode: 0, stderr: '', results: [{ status: 'installed' }] })).toBe(true);
    expect(isSuccess({ command, exitCode: 0, stderr: '', results: [{ status: 'skipped' }] })).toBe(false);
    expect(isSuccess({ command, exitCode: 1, stderr: '', results: [] })).toBe(false);
  });
});

describe('removal', () => {
  it('builds one remove call for every agent of the scope', () => {
    expect(planRemove([], { scope: 'project', skillsVersion: '1.7.0' })).toEqual([]);
    const [cmd] = planRemove(['pdf', 'docx', 'pdf'], { scope: 'global', skillsVersion: '1.7.0' });
    expect(cmd!.kind).toBe('remove');
    expect(cmd!.args).toEqual(['-y', 'skills@1.7.0', 'remove', '-s', 'pdf', 'docx', '-y', '-g']);
    expect(cmd!.args).not.toContain('-a');
  });

  it('removes each skill from every scope it is installed in, project first', () => {
    const cmds = planRemovals(
      [
        { name: 'pdf', scopes: ['project', 'global'] },
        { name: 'docx', scopes: ['global'] },
      ],
      '1.7.0',
    );
    expect(cmds.map((c) => [c.scope, c.skills])).toEqual([
      ['project', ['pdf']],
      ['global', ['pdf', 'docx']],
    ]);
    expect(cmds[1]!.args.at(-1)).toBe('-g');
  });

  it('judges a removal by its verified results', () => {
    const command = { kind: 'remove' as const, source: '', skills: ['x'], args: [], scope: 'project' as const };
    expect(isSuccess({ command, exitCode: 0, stderr: '', results: [{ name: 'x', status: 'removed' }] })).toBe(true);
    expect(isSuccess({ command, exitCode: 0, stderr: '', results: [{ name: 'x', status: 'failed' }] })).toBe(false);
  });
});

describe('installed skills scan', () => {
  const skill = (dir: string, name?: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\n${name ? `name: ${name}\n` : ''}description: x\n---\nbody`);
  };

  it('reads skill directories of the canonical dir and every agent, with lock sources', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skills-atlas-'));
    try {
      skill(join(cwd, '.claude', 'skills', 'pdf'), 'pdf');
      skill(join(cwd, '.agents', 'skills', 'pdf'), 'pdf');
      skill(join(cwd, '.agents', 'skills', 'folder-name'), 'Real Name');
      skill(join(cwd, '.windsurf', 'skills', 'nameless'));
      mkdirSync(join(cwd, '.claude', 'skills', 'not-a-skill'), { recursive: true });
      writeFileSync(
        join(cwd, 'skills-lock.json'),
        JSON.stringify({ version: 1, skills: { pdf: { source: 'anthropics/skills' }, 'real name': { source: 'local' } } }),
      );
      const found = scanInstalled('project', cwd);
      expect(found.map((s) => s.name)).toEqual(['nameless', 'pdf', 'Real Name']);
      const pdf = found.find((s) => s.name === 'pdf')!;
      expect(pdf.source).toBe('anthropics/skills');
      expect(pdf.agents).toEqual(expect.arrayContaining(['Claude Code', 'Codex', 'Cursor']));
      expect(found.find((s) => s.name === 'Real Name')!.source).toBeUndefined();
      expect(found.find((s) => s.name === 'nameless')!.agents).toEqual(['Windsurf']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('finds nothing in an empty project', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'skills-atlas-'));
    try {
      expect(scanInstalled('project', cwd)).toEqual([]);
      expect(readLockSources(join(cwd, 'missing.json')).size).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reads the frontmatter name, quoted or not', () => {
    expect(frontmatterName('---\nname: pdf\n---')).toBe('pdf');
    expect(frontmatterName('---\nname: "My Skill"\ndescription: x\n---')).toBe('My Skill');
    expect(frontmatterName('no frontmatter')).toBeUndefined();
  });

  it('honours the environment overrides of the skills CLI', () => {
    const saved = { ...process.env };
    try {
      process.env.CLAUDE_CONFIG_DIR = join('X:', 'claude');
      process.env.XDG_STATE_HOME = join('X:', 'state');
      expect(expandHome('~/.claude/skills')).toBe(join('X:', 'claude', 'skills'));
      expect(lockPath('global', '.')).toBe(join('X:', 'state', 'skills', '.skill-lock.json'));
      expect(lockPath('project', 'P:')).toBe(join('P:', 'skills-lock.json'));
    } finally {
      process.env = saved;
    }
  });
});

describe('progress', () => {
  it('follows the phases printed by skills add, never going back', () => {
    expect(phaseOf('npm warn', 'queued')).toBe('fetching');
    expect(phaseOf('[1m●  Selected 2 skills: docx, pdf', 'fetching')).toBe('installing');
    expect(phaseOf('Installation Summary ───', 'installing')).toBe('auditing');
    expect(phaseOf('Selected 1 skill', 'auditing')).toBe('auditing');
    expect(phaseOf('anything', 'done')).toBe('done');
  });

  it('fills each phase band over time and ends full', () => {
    expect(barFraction('queued', 5000)).toBe(0);
    const early = barFraction('fetching', 100);
    const late = barFraction('fetching', 20_000);
    expect(early).toBeGreaterThan(0.04);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(0.55);
    expect(barFraction('installing', 0)).toBeCloseTo(0.55);
    expect(barFraction('done', 0)).toBe(1);
  });
});
