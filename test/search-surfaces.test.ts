import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { querySkills } from '../src/catalog/query.js';
import { createHandler } from '../src/mcp.js';
import type { Catalog, Skill } from '../src/types.js';

const dir = mkdtempSync(join(tmpdir(), 'atlas-search-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const mk = (name: string, installs: number, description = '', labels: string[] = []): Skill => ({
  id: `o/r@${name}`, name, source: 'o/r', installs, description, labels, themes: ['frontend'], origins: [],
});
const catalog: Catalog = {
  version: 1, generatedAt: '2026-10-18', themes: [{ id: 'frontend', label: 'Frontend' }],
  skills: [mk('popular', 900, 'Café résumé'), mk('café-tools', 10), mk('café', 1), mk('label', 20, '', ['café', 'résumé'])],
  stats: { raw: { 'skills.sh': 0, smithery: 0, 'claude-plugins.dev': 0 }, merged: 4, byTheme: { frontend: 4 } },
};
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (script: string, args: string[] = []) => execFileSync(process.execPath, ['--import', loader, fileURLToPath(new URL(script, import.meta.url)), ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: dir, CI: 'true' }, timeout: 30_000,
});

describe('search surfaces', () => {
  it('ranks CLI list searches and preserves explicit sorting', () => {
    const path = join(dir, 'catalog.json');
    writeFileSync(path, JSON.stringify(catalog));
    for (const sort of [undefined, 'installs', 'name'] as const) {
      const output = run('../src/launch.ts', ['list', '--catalog', path, '--offline', '--json', '--lang', 'en', '--search', 'CAFE', ...(sort ? ['--sort', sort] : [])]);
      const ids = JSON.parse(output).find((g: any) => g.theme.id === 'frontend').skills.map((s: Skill) => s.id);
      expect(ids).toEqual(querySkills(catalog, { search: 'CAFE', sort }).map(s => s.id));
    }
  }, 30_000);

  it('ranks MCP searches with the same normalized terms', async () => {
    const handle = createHandler({ version: '1', skillsVersion: '1.7.0', loadCatalog: async () => catalog });
    const result: any = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_skills', arguments: { query: 'CAFE resume' } } });
    expect(JSON.parse(result.result.content[0].text).map((s: Skill) => s.id)).toEqual(querySkills(catalog, { search: 'CAFE resume' }).map(s => s.id));
  });

  it('builds an offline demo using the same matching and ranking', async () => {
    run('../scripts/build-demo.ts');
    const html = readFileSync(join(dir, 'docs/demo/index.html'), 'utf8');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]![1]!;
    const context: any = { window: {}, location: { href: 'https://example.test/demo/' }, URL, Response };
    new Script(script.replace(/var DEMO = .*;/, `var DEMO = ${JSON.stringify({ state: {}, skills: catalog.skills })};`)).runInNewContext(context);
    for (const query of ['CAFE', 'cafe resume', 'cafe absent', '']) {
      const response = await context.window.fetch(`/api/skills?q=${encodeURIComponent(query)}`);
      expect((await response.json()).items.map((s: Skill) => s.id)).toEqual(querySkills(catalog, { search: query, sort: query ? undefined : 'installs' }).map(s => s.id));
    }
    const response = await context.window.fetch('/api/skills?q=cafe&sort=name');
    expect((await response.json()).items.map((s: Skill) => s.id)).toEqual(querySkills(catalog, { search: 'cafe', sort: 'name' }).map(s => s.id));
  });
});
