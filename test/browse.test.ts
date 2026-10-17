import { describe, expect, it, vi } from 'vitest';
import { browseLoop } from '../src/browse.js';
import type { WizardResult } from '../src/ui/App.js';

const result = (id: string): WizardResult => ({
  ids: [id], remove: [], update: [],
  options: { agents: ['claude-code'], scope: 'global', method: 'symlink', skillsVersion: '1.7.0' },
});

describe('browse loop', () => {
  it('goes back to the wizard with the summary of each run until the user quits', async () => {
    const answers = [result('a/b@one'), result('a/b@two'), null];
    const wizard = vi.fn(async (_notice: string) => answers.shift()!);
    const apply = vi.fn(async (r: WizardResult) => `installed ${r.ids[0]}`);
    expect(await browseLoop(wizard, apply)).toBe(2);
    expect(wizard.mock.calls.map(([notice]) => notice)).toEqual(['', 'installed a/b@one', 'installed a/b@two']);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('applies nothing when the user leaves straight away', async () => {
    const apply = vi.fn(async () => '');
    expect(await browseLoop(async () => null, apply)).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('stops after a dry run has printed its commands', async () => {
    const wizard = vi.fn(async () => result('a/b@one'));
    expect(await browseLoop(wizard, async () => '', { dryRun: true })).toBe(1);
    expect(wizard).toHaveBeenCalledOnce();
  });
});
