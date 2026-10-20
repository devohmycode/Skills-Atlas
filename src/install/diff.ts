import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSkillMarkdown, stripControls } from '../github.js';
import { scanRisks, type Risk } from '../risks.js';
import type { Skill } from '../types.js';
import { listInstalled, type InstalledSkill } from './run.js';

export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
}

/** Above this many line pairs the diff is not computed line by line. */
const MAX_CELLS = 4_000_000;

/** A line diff by longest common subsequence: SKILL.md files are a few hundred lines. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // shortcut: very long files show as replaced whole, which is honest but coarse; use Myers if that shows up.
  if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ kind: '-' as const, text })), ...b.map((text) => ({ kind: '+' as const, text }))];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push({ kind: '+', text: b[j++]! });
    else out.push({ kind: '-', text: a[i++]! });
  }
  return out;
}

/** Warning signs of the new version that the installed one did not have (same rule and same line text). */
export function newRisks(before: string, after: string): Risk[] {
  const known = new Set(scanRisks(before).map((r) => `${r.rule}\n${r.excerpt}`));
  return scanRisks(after).filter((r) => !known.has(`${r.rule}\n${r.excerpt}`));
}

export interface UpdateDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  risks: Risk[];
}

/** What an update changes in a skill's SKILL.md: the installed copy against the repository's. */
export async function updateDiff(
  skill: Pick<Skill, 'source' | 'name' | 'path'>,
  installed?: InstalledSkill[],
  read: (s: Pick<Skill, 'source' | 'name' | 'path'>) => Promise<string> = fetchSkillMarkdown,
): Promise<UpdateDiff> {
  const all = installed ?? (await listInstalled('global'));
  const local = all.find((s) => s.source?.toLowerCase() === skill.source.toLowerCase() && s.name.toLowerCase() === skill.name.toLowerCase() && s.path);
  if (!local) throw new Error(`${skill.source}@${skill.name} is not installed globally`);
  const before = stripControls(readFileSync(join(local.path!, 'SKILL.md'), 'utf8'));
  const after = await read(skill);
  const lines = lineDiff(before, after);
  return {
    lines,
    added: lines.filter((l) => l.kind === '+').length,
    removed: lines.filter((l) => l.kind === '-').length,
    risks: newRisks(before, after),
  };
}

/** Changed lines with a few lines of context around them; long unchanged stretches become `…`. */
export function diffText(lines: DiffLine[], context = 2): string {
  const near = lines.map((_, i) => lines.slice(Math.max(0, i - context), i + context + 1).some((l) => l.kind !== ' '));
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (near[i]) out.push(`${l.kind} ${l.text}`);
    else if (out.at(-1) !== '  …') out.push('  …');
  });
  return out.join('\n');
}
