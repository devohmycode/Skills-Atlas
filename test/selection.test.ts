import { describe, expect, it } from 'vitest';
import { missingSkillsByAgent, parseSelection, toSelection } from '../src/selection.js';
import { AGENTS } from '../src/agents.js';

describe('selections', () => {
  it('exports each installed skill once, and sets aside the ones without a source', () => {
    const { selection, skipped } = toSelection([
      { name: 'pdf', source: 'anthropics/skills', scope: 'project', agents: [] },
      { name: 'pdf', source: 'anthropics/skills', scope: 'global', agents: [] },
      { name: 'ponytail', source: 'DietrichGebert/ponytail', scope: 'global', agents: [] },
      { name: 'homemade', scope: 'project', agents: [] },
    ]);
    expect(selection).toEqual({ skillsAtlas: 1, skills: ['DietrichGebert/ponytail@ponytail', 'anthropics/skills@pdf'] });
    expect(skipped).toEqual(['homemade']);
    // What export writes, import reads back.
    expect(parseSelection(JSON.stringify(selection))).toEqual(selection.skills);
  });

  it('keeps real names, odd characters included', () => {
    expect(parseSelection('{"skillsAtlas":1,"skills":["a/b@PDF Merge & Split","a/b@x","a/b@x"]}')).toEqual(['a/b@PDF Merge & Split', 'a/b@x']);
  });

  it('refuses a file that could inject flags or break shell quoting', () => {
    const file = (skills: string[]) => JSON.stringify({ skillsAtlas: 1, skills });
    expect(() => parseSelection('not json')).toThrow(/JSON/);
    expect(() => parseSelection('{"skills":[]}')).toThrow(/selection/);
    expect(() => parseSelection(file(['evil'] ))).toThrow(/owner\/repo/);
    expect(() => parseSelection(file(['a/b;rm -rf@x']))).toThrow(/owner\/repo/);
    expect(() => parseSelection(file(['a/b@--global']))).toThrow(/invalid skill name/);
    expect(() => parseSelection(file(['a/b@x" & calc "']))).toThrow(/invalid skill name/);
    expect(() => parseSelection(file(['a/b@x\u001b[2J']))).toThrow(/invalid skill name/);
  });
});

describe('project file', () => {
  const installed = [
    { name: 'PDF', source: 'A/B', scope: 'project' as const, agents: ['Claude Code'] },
    { name: 'hooks', source: 'c/d', scope: 'project' as const, agents: ['claude-code', 'cursor'] },
  ];

  it('groups only the skills missing from each target agent', () => {
    expect(missingSkillsByAgent(['a/b@pdf', 'c/d@hooks'], installed, ['claude-code', 'cursor'])).toEqual([
      { agents: ['cursor'], ids: ['a/b@pdf'] },
    ]);
    expect(missingSkillsByAgent(['a/b@pdf'], installed, ['claude-code'])).toEqual([]);
    expect(missingSkillsByAgent(['x/y@new'], installed, ['claude-code', 'cursor', 'cursor'])).toEqual([
      { agents: ['claude-code', 'cursor'], ids: ['x/y@new'] },
    ]);
  });

  it('checks every supported agent for a wildcard and rejects unknown targets', () => {
    const groups = missingSkillsByAgent(['a/b@pdf'], installed, ['*']);
    expect(groups).toEqual([{ agents: AGENTS.filter((a) => a.id !== 'claude-code').map((a) => a.id), ids: ['a/b@pdf'] }]);
    expect(() => missingSkillsByAgent([], installed, ['unknown-agent'])).toThrow(/unknown-agent/);
  });

  it('reads the agents a project names, and finds what is not installed yet', async () => {
    const { missingSkills, parseSelectionFile } = await import('../src/selection.js');
    expect(parseSelectionFile('{"skillsAtlas":1,"agents":["claude-code"],"skills":["a/b@x","c/d@y"]}')).toEqual({ ids: ['a/b@x', 'c/d@y'], agents: ['claude-code'] });
    expect(parseSelectionFile('{"skillsAtlas":1,"skills":["a/b@x"]}').agents).toBeUndefined();
    expect(missingSkills(['A/B@x', 'c/d@y'], ['a/b@X', 'local@z'])).toEqual(['c/d@y']);
  });
});
