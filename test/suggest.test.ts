import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectStack, suggestSkills } from '../src/suggest.js';
import type { Catalog, Skill } from '../src/types.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function project(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'atlas-suggest-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const skill = (id: string, installs: number, extra: Partial<Skill> = {}): Skill => {
  const [source, name] = id.split('@') as [string, string];
  return { id, name, source, installs, labels: [], origins: [], themes: [], ...extra };
};
const catalog = (skills: Skill[]): Catalog => ({
  version: 1, generatedAt: '2026-11-01', themes: [], skills,
  stats: { raw: { 'skills.sh': 0, smithery: 0, 'claude-plugins.dev': 0 }, merged: skills.length, byTheme: {} },
});

describe('project stack', () => {
  it('reads npm workspaces, Python and Rust manifests and telltale files', () => {
    const dir = project({
      'apps/web/package.json': JSON.stringify({ dependencies: { next: '15', react: '19', '@supabase/supabase-js': '2' }, devDependencies: { vitest: '3' } }),
      'pyproject.toml': '[project]\nname = "api"\ndependencies = ["FastAPI>=0.110", "anthropic"]\n[tool.pytest.ini_options]\n',
      'Cargo.toml': '[package]\nname = "x"\n[dependencies]\ntauri = "2"\nserde = "1"\n',
      'Dockerfile': 'FROM node',
      '.github/workflows/ci.yml': 'on: push',
      'prisma/schema.prisma': '',
    });
    const found = detectStack(dir);
    expect(found.map((s) => s.id)).toEqual(['react', 'nextjs', 'tauri', 'supabase', 'prisma', 'vitest', 'fastapi', 'anthropic', 'rust', 'docker', 'github-actions']);
    expect(found.find((s) => s.id === 'react')!.evidence).toEqual(['apps/web/package.json: react']);
    expect(found.find((s) => s.id === 'fastapi')!.evidence).toEqual(['pyproject.toml: fastapi']);
    expect(found.find((s) => s.id === 'github-actions')!.evidence).toEqual(['.github/workflows/']);
    // `[tool.pytest…]` configures pytest, it does not depend on it.
    expect(found.some((s) => s.id === 'pytest')).toBe(false);
  });

  it('finds nothing in an empty folder or a broken package.json', () => {
    expect(detectStack(project({ 'package.json': '{ not json' }))).toEqual([]);
  });
});

describe('suggestions', () => {
  const skills = [
    skill('vercel-labs/agent-skills@vercel-react-best-practices', 800_000),
    skill('someone/kit@react-patterns', 9_000),
    skill('copy/kit@react-patterns', 8_000),
    skill('callstack/skills@react-native-best-practices', 50_000),
    skill('tiny/kit@react-tips', 20),
    skill('old/kit@react-legacy', 7_000, { repo: { archived: true } }),
    skill('dep/kit@react-old', 6_000, { description: 'Deprecated: use react-patterns' }),
    skill('supabase/agent-skills@supabase', 300_000),
    skill('fan/kit@supabase-tricks', 900_000),
    skill('auth/kit@supabase-react-login', 5_000),
  ];

  it('ranks the picks, then names starting with the technology, leaving out copies, idle, deprecated and rare skills', () => {
    const found = suggestSkills(catalog(skills), [{ id: 'react', label: 'React', evidence: ['package.json: react'] }]);
    expect(found.stack[0]!.skills.map((s) => s.id)).toEqual([
      'vercel-labs/agent-skills@vercel-react-best-practices',
      'someone/kit@react-patterns',
      'auth/kit@supabase-react-login',
    ]);
    expect(found.packs).toEqual(['frontend']);
  });

  it("puts the technology's publisher first, and never suggests what is installed", () => {
    const signals = [{ id: 'supabase', label: 'Supabase', evidence: ['package.json: @supabase/supabase-js'] }];
    expect(suggestSkills(catalog(skills), signals).stack[0]!.skills.map((s) => s.id).slice(0, 2)).toEqual(['supabase/agent-skills@supabase', 'fan/kit@supabase-tricks']);
    const without = suggestSkills(catalog(skills), signals, { installed: ['Supabase/Agent-Skills@supabase'] });
    expect(without.stack[0]!.skills.map((s) => s.id)[0]).toBe('fan/kit@supabase-tricks');
  });

  it('shows a skill under the first technology only', () => {
    const found = suggestSkills(catalog(skills), [
      { id: 'react', label: 'React', evidence: [] },
      { id: 'supabase', label: 'Supabase', evidence: [] },
    ], { perStack: 5 });
    const all = found.stack.flatMap((s) => s.skills.map((k) => k.id));
    expect(new Set(all).size).toBe(all.length);
  });
});
