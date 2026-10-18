import { describe, expect, it, vi } from 'vitest';
import type { CommandOutcome } from '../src/install/run.js';
import { createHandler } from '../src/mcp.js';
import type { Catalog } from '../src/types.js';

const skill = (id: string, installs: number, themes = ['documents']) => {
  const [source, name] = id.split('@') as [string, string];
  return { id, name, source, description: `${name} tools`, installs, labels: [], origins: [], themes };
};
const catalog: Catalog = {
  version: 1, generatedAt: '2026-10-17', themes: [{ id: 'documents', label: 'Documents' }],
  skills: [skill('anthropics/skills@pdf', 900), skill('a/b@pdf-lite', 10), skill('c/d@deploy', 50, ['devops'])],
  stats: { raw: { 'skills.sh': 0, smithery: 0, 'claude-plugins.dev': 0 }, merged: 3, byTheme: { documents: 2 } },
};

function server(run = vi.fn(async (): Promise<CommandOutcome[]> => [])) {
  const installed = async () => [{ id: 'other/repo@deploy', name: 'deploy', source: 'other/repo', scope: 'global' as const, agents: ['claude-code'] }];
  const handle = createHandler({ version: '9.9.9', skillsVersion: '1.7.0', loadCatalog: async () => catalog, run: run as never, installed });
  let id = 0;
  const call = async (name: string, args: object) => {
    const res = (await handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })) as any;
    return { text: res.result.content[0].text as string, isError: res.result.isError as boolean | undefined };
  };
  return { handle, call, run };
}

describe('MCP server', () => {
  it('introduces itself and lists its tools', async () => {
    const { handle } = server();
    const init = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as any;
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'skills-atlas', version: '9.9.9' }, capabilities: { tools: {} } });
    const list = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as any;
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(
      ['search_skills', 'list_themes', 'show_skill', 'list_packs', 'list_installed', 'outdated_skills', 'install_skills', 'remove_skills'],
    );
    // Notifications get no answer; unknown methods a JSON-RPC error.
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(await handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).toMatchObject({ error: { code: -32601 } });
  });

  it('searches the catalog, most installed first', async () => {
    const { call } = server();
    const found = JSON.parse((await call('search_skills', { query: 'pdf' })).text);
    expect(found.map((s: { id: string }) => s.id)).toEqual(['anthropics/skills@pdf', 'a/b@pdf-lite']);
    expect(found[0]).toMatchObject({ installs: 900, url: 'https://github.com/anthropics/skills' });
    const themes = JSON.parse((await call('list_themes', {})).text);
    expect(themes).toEqual([{ id: 'documents', label: 'Documents', skills: 2 }]);
  });

  it('plans installs, runs them, and refuses what could inject flags', async () => {
    const run = vi.fn(async (): Promise<CommandOutcome[]> => []);
    const { call } = server(run);
    const dry = JSON.parse((await call('install_skills', { ids: ['anthropics/skills@pdf'], agents: ['claude-code'], scope: 'global', dry_run: true })).text);
    expect(dry.commands).toEqual(['npx -y skills@1.7.0 add anthropics/skills -s pdf -a claude-code -g -y --json']);
    expect(run).not.toHaveBeenCalled();
    await call('install_skills', { ids: ['anthropics/skills@pdf'], agents: ['claude-code'], scope: 'project' });
    expect(run).toHaveBeenCalledOnce();
    expect((await call('install_skills', { ids: ['a/b@--global'], agents: ['claude-code'], scope: 'global' })).text).toMatch(/invalid skill name/);
    expect((await call('install_skills', { ids: ['a/b@x'], agents: ['nope'], scope: 'global' })).text).toMatch(/unknown agents: nope/);
    expect((await call('remove_skills', { names: ['-rf'], scope: 'global' })).isError).toBe(true);
    const bad = await call('install_skills', { ids: [], agents: ['claude-code'], scope: 'everywhere' });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/invalid arguments/);
    expect(run).toHaveBeenCalledOnce();
  });

  it('refuses to let a skill replace another of the same name without replace: true', async () => {
    const run = vi.fn(async (): Promise<CommandOutcome[]> => []);
    const { call } = server(run);
    const args = { ids: ['c/d@deploy'], agents: ['claude-code'], scope: 'global' };
    const dry = JSON.parse((await call('install_skills', { ...args, dry_run: true })).text);
    expect(dry.collisions).toEqual([{ name: 'deploy', incoming: 'c/d@deploy', replaced: 'other/repo@deploy', installed: true }]);
    const refused = await call('install_skills', args);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/Nothing installed: c\/d@deploy would replace other\/repo@deploy \(installed\)/);
    expect(run).not.toHaveBeenCalled();
    await call('install_skills', { ...args, replace: true });
    expect(run).toHaveBeenCalledOnce();
  });
});
