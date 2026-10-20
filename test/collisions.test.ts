import { describe, expect, it } from 'vitest';
import { skillsByAgent } from '../src/agent-api.js';
import { nameCollisions } from '../src/install/collisions.js';
import { agentList } from '../src/ui/TreeSelect.js';

describe('name collisions', () => {
  it('flags a skill that would replace an installed one from another source', () => {
    expect(nameCollisions(['c/d@pdf'], ['anthropics/skills@pdf', 'a/b@tdd'])).toEqual([
      { name: 'pdf', incoming: 'c/d@pdf', replaced: 'anthropics/skills@pdf', installed: true },
    ]);
  });

  it('flags two selected skills sharing a name, the later replacing the earlier', () => {
    expect(nameCollisions(['a/b@PDF', 'c/d@pdf'], [])).toEqual([{ name: 'pdf', incoming: 'c/d@pdf', replaced: 'a/b@PDF', installed: false }]);
  });

  it('lets a skill from the same repository reinstall, and counts a home-made skill as another source', () => {
    expect(nameCollisions(['Anthropics/Skills@pdf'], ['anthropics/skills@pdf'])).toEqual([]);
    expect(nameCollisions(['a/b@notes'], ['local@notes'])).toMatchObject([{ replaced: 'local@notes', installed: true }]);
  });
});

describe('skills by agent', () => {
  it('lists, under each agent, the skills it sees', () => {
    const groups = skillsByAgent([
      { id: 'a/b@zeta', name: 'zeta', source: 'a/b', scope: 'global', agents: ['codex', 'claude-code'] },
      { id: 'a/b@alpha', name: 'alpha', source: 'a/b', scope: 'project', agents: ['codex'] },
    ]);
    expect(groups.map((g) => [g.name, g.skills.map((s) => s.name)])).toEqual([['Claude Code', ['zeta']], ['Codex', ['alpha', 'zeta']]]);
    expect(agentList(['Zed', 'Codex', 'Cursor', 'Claude Code', 'Amp'])).toBe('Amp, Claude Code, Codex +2');
  });
});
