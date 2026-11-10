import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeInstalled, findOverlaps, words } from '../src/overlaps.js';
import { scanUsage, transcriptsDir, usageReport, usesInLine } from '../src/usage.js';

const line = (type: string, timestamp: string, content: unknown) => JSON.stringify({ type, timestamp, message: { content } });
const skillCall = (skill: string) => [{ type: 'tool_use', name: 'Skill', input: { skill } }];

describe('skill usage in transcripts', () => {
  it('reads a Skill call, a slash command and a SKILL.md read, whatever prefix names the skill', () => {
    expect(usesInLine(line('assistant', 't', skillCall('claude-seo:seo-audit')))).toEqual(['seo-audit']);
    expect(usesInLine(line('user', 't', '<command-name>/brainstorming</command-name> <command-args></command-args>'))).toEqual(['brainstorming']);
    expect(usesInLine(line('user', 't', [{ type: 'text', text: '<command-name>/Report</command-name>' }]))).toEqual(['report']);
    expect(usesInLine(line('assistant', 't', [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\Users\\me\\.claude\\skills\\pdf\\SKILL.md' } }]))).toEqual(['pdf']);
  });

  it('ignores what only mentions a skill: a tool result, an assistant quoting a command, a broken line', () => {
    expect(usesInLine(line('user', 't', [{ type: 'tool_result', content: '"name":"Skill" docs/SKILL.md' }]))).toEqual([]);
    expect(usesInLine(line('assistant', 't', [{ type: 'text', text: '<command-name>/pdf</command-name>' }]))).toEqual([]);
    expect(usesInLine(line('assistant', 't', [{ type: 'tool_use', name: 'Read', input: { file_path: 'docs/SKILL.md.bak' } }]))).toEqual([]);
    expect(usesInLine('{"type":"assistant","name":"Skill"')).toEqual([]);
  });

  const transcripts = () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-usage-'));
    mkdirSync(join(dir, 'proj', 'session', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'proj', 'a.jsonl'), [
      line('assistant', '2026-11-01T10:00:00.000Z', skillCall('pdf')),
      line('assistant', '2026-11-05T10:00:00.000Z', skillCall('pdf')),
      line('assistant', '2026-09-01T10:00:00.000Z', skillCall('old-one')),
      line('user', '2026-11-02T10:00:00.000Z', 'plain text'),
      // A copy of the request, without a date: the same call must not count twice.
      JSON.stringify({ type: 'api-request-blob', message: { content: skillCall('pdf') } }),
    ].join('\n'));
    writeFileSync(join(dir, 'proj', 'session', 'subagents', 'b.jsonl'), `${line('assistant', '2026-11-03T10:00:00.000Z', skillCall('plugin:docx'))}\n`);
    writeFileSync(join(dir, 'proj', 'stale.jsonl'), line('assistant', '2026-11-04T10:00:00.000Z', skillCall('never-read')));
    utimesSync(join(dir, 'proj', 'stale.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
    writeFileSync(join(dir, 'proj', 'notes.txt'), line('assistant', '2026-11-04T10:00:00.000Z', skillCall('not-a-transcript')));
    return dir;
  };
  const since = new Date('2026-10-15T00:00:00.000Z');

  it('counts the uses dated in the window, in transcripts changed in it, subagents included', () => {
    const scan = scanUsage(transcripts(), since);
    expect(scan.files).toBe(2);
    expect([...scan.uses]).toEqual([['pdf', { count: 2, last: '2026-11-05' }], ['docx', { count: 1, last: '2026-11-03' }]]);
    expect(scanUsage(join(tmpdir(), 'no-such-transcripts'), since)).toEqual({ files: 0, skipped: 0, uses: new Map() });
    expect(transcriptsDir({ CLAUDE_CONFIG_DIR: join('x', 'y') })).toBe(join('x', 'y', 'projects'));
  });

  it('sorts installed skills into used, unused, too recent and unknown', () => {
    const skill = (name: string, agents: string[], path = name) => ({ name, scope: 'global' as const, agents, path });
    const installed = [skill('pdf', ['Claude Code']), skill('xlsx', ['Claude Code']), skill('fresh', ['Claude Code']), skill('codex-only', ['Codex']), skill('renamed', ['Claude Code'], 'docx')];
    const born = (path: string) => (path === 'fresh' ? since.getTime() + 1 : since.getTime() - 1);
    const report = usageReport(installed, scanUsage(transcripts(), since), since, born, (s) => [s.name, s.path!]);
    expect(report.used.map((s) => [s.name, s.count, s.last])).toEqual([['pdf', 2, '2026-11-05'], ['renamed', 1, '2026-11-03']]);
    expect(report.unused.map((s) => s.name)).toEqual(['xlsx']);
    expect(report.recent.map((s) => s.name)).toEqual(['fresh']);
    expect(report.unknown.map((s) => s.name)).toEqual(['codex-only']);
  });
});

describe('overlapping descriptions', () => {
  const skill = (name: string, description: string, agents = ['Claude Code']) => ({ name, description, scope: 'global' as const, agents });
  const installed = [
    skill('review', 'Review code changes for bugs and security issues before merging a pull request.'),
    skill('review-bugbot', 'Review the code changes of a pull request for bugs before merging.'),
    skill('pdf', 'Read, fill and merge PDF forms and documents.'),
    skill('xlsx', 'Create and edit spreadsheets with formulas and charts.'),
    skill('review-codex', 'Review code changes for bugs and security issues before merging a pull request.', ['Codex']),
  ];

  it('keeps the words that say what a description is about', () => {
    expect(words('Use this skill when the user wants to review Pull-Requests, reviewing changes.')).toEqual(['review', 'pull', 'request', 'review', 'chang']);
    expect(words('Crée des rapports d’audit')).toEqual(['cree', 'rapport', 'audit']);
  });

  it('reports the pairs a same agent sees with close descriptions, the closest first, and the words they share', () => {
    const found = findOverlaps(installed);
    expect(found.map((o) => [o.a.name, o.b.name])).toEqual([['review', 'review-bugbot']]);
    expect(found[0]!.score).toBeGreaterThan(0.5);
    expect(found[0]!.shared).toEqual(expect.arrayContaining(['review', 'bug']));
    expect(found[0]!.agents).toEqual(['Claude Code']);
    expect(findOverlaps(installed, 0.99)).toEqual([]);
    expect(findOverlaps([])).toEqual([]);
  });

  it('reads each description from its SKILL.md and leaves out a skill without one', () => {
    const files: Record<string, string> = { a: '---\nname: a\ndescription: Fill PDF forms.\n---\nbody', b: 'no frontmatter' };
    const read = (path: string) => { if (!(path in files)) throw new Error('gone'); return files[path]!; };
    const all = ['a', 'b', 'c'].map((name) => ({ name, scope: 'project' as const, agents: ['Codex'], path: name }));
    expect(describeInstalled([...all, { name: 'd', scope: 'project', agents: [] }], read)).toEqual([{ name: 'a', description: 'Fill PDF forms.', scope: 'project', source: undefined, agents: ['Codex'] }]);
  });
});
