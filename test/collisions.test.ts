import { describe, expect, it } from 'vitest';
import { nameCollisions } from '../src/install/collisions.js';

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
