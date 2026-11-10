import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentLoads, estimateTokens, folderCost, formatBytes, heavyLoads, markdownCost } from '../src/context.js';

describe('context cost', () => {
  it('estimates about 4 characters per token, one per CJK character', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('漢字')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('counts the name and the whole description at startup, the whole SKILL.md when used', () => {
    const long = 'x'.repeat(800);
    const md = `---\nname: pdf\ndescription: ${long}\n---\n# PDF\n${'body '.repeat(200)}`;
    const cost = markdownCost(md);
    // A long description is not cut at the catalog's 400 characters.
    expect(cost.startup).toBe(estimateTokens(`pdf: ${long}`));
    expect(cost.onUse).toBe(estimateTokens(md));
    expect(markdownCost('# no frontmatter', 'fallback').startup).toBe(estimateTokens('fallback: '));
  });

  it("reads an installed folder's files and bytes, without .git or node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cost-'));
    try {
      const md = '---\nname: a\ndescription: does a\n---\n';
      writeFileSync(join(dir, 'SKILL.md'), md);
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo hi\n');
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', 'big.js'), 'x'.repeat(10_000));
      expect(folderCost(dir)).toMatchObject({ startup: estimateTokens('a: does a'), files: 2, bytes: Buffer.byteLength(md) + 8 });
      expect(folderCost(join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sums each agent's startup load, heaviest first, and flags the ones over budget", () => {
    const cost = { a: { startup: 3000, onUse: 0 }, b: { startup: 2500, onUse: 0 }, c: { startup: 100, onUse: 0 } } as Record<string, { startup: number; onUse: number }>;
    const loads = agentLoads([
      { name: 'a', scope: 'global', agents: ['Claude Code', 'Codex'] },
      { name: 'b', scope: 'project', agents: ['Claude Code'] },
      { name: 'c', scope: 'global', agents: ['Codex'] },
    ], (s) => cost[s.name]);
    expect(loads).toEqual([{ agent: 'Claude Code', skills: 2, startup: 5500 }, { agent: 'Codex', skills: 2, startup: 3100 }]);
    expect(heavyLoads(loads).map((l) => l.agent)).toEqual(['Claude Code']);
    expect([formatBytes(840), formatBytes(12_595), formatBytes(3 * 1024 * 1024)]).toEqual(['840 B', '12.3 KB', '3.0 MB']);
  });
});
