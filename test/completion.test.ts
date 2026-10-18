import { describe, expect, it } from 'vitest';
import { complete, completionScript, FILES, type CompletionContext } from '../src/completion.js';

const ctx: CompletionContext = {
  commands: [
    { name: 'browse', options: ['-a', '--agent', '-t', '--theme', '-g'] },
    { name: 'install', options: ['-a', '--agent', '-g', '--dry-run'] },
    { name: 'import', options: ['-a'] },
    { name: 'show', options: ['--json'] },
    { name: 'lang', options: [] },
    { name: 'completion', options: [] },
  ],
  globalOptions: ['-l', '--lang'],
  agents: ['claude-code', 'codex', 'cursor'],
  langs: ['en', 'fr'],
  themes: () => ['frontend', 'security'],
  ids: (prefix) => ['obra/superpowers@brainstorming', 'obra/superpowers@writing-plans', 'anthropics/skills@pdf'].filter((id) => id.startsWith(prefix)),
};

describe('completion', () => {
  it('offers commands, then their options', () => {
    expect(complete(['i'], ctx)).toEqual(['install', 'import']);
    expect(complete(['-l', 'fr', 'sh'], ctx)).toEqual(['show']);
    expect(complete(['install', '--d'], ctx)).toEqual(['--dry-run']);
    expect(complete(['show', '--'], ctx)).toEqual(['--json', '--lang']);
  });

  it('offers skill ids, agents and themes where they go', () => {
    expect(complete(['install', 'obra/'], ctx)).toEqual(['obra/superpowers@brainstorming', 'obra/superpowers@writing-plans']);
    expect(complete(['install', 'x/y@z', '-a', 'c'], ctx)).toEqual(['claude-code', 'codex', 'cursor']);
    // -a takes several agents: still agents after the first one.
    expect(complete(['install', '-a', 'claude-code', 'cu'], ctx)).toEqual(['cursor']);
    expect(complete(['browse', '-t', ''], ctx)).toEqual(['frontend', 'security']);
    expect(complete(['-l', ''], ctx)).toEqual(['en', 'fr']);
    // -l takes one: the word after its value is a command again.
    expect(complete(['-l', 'fr', ''], ctx)).toEqual(['browse', 'install', 'import', 'show', 'lang', 'completion']);
  });

  it('leaves file names to the shell for import, and knows the shells', () => {
    expect(complete(['import', 'my-'], ctx)).toEqual([FILES]);
    expect(complete(['completion', 'z'], ctx)).toEqual(['zsh']);
    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) expect(completionScript(shell)).toContain('__complete --');
    expect(completionScript('tcsh')).toBeUndefined();
  });
});
