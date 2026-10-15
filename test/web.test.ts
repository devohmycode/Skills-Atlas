import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstallCommand } from '../src/install/plan.js';
import type { CommandOutcome, InstalledSkill } from '../src/install/run.js';
import type { Skill } from '../src/types.js';
import { startServer, type AtlasServer } from '../src/web/server.js';
import { withRecommendations } from '../src/catalog/recommended.js';
import { querySkills } from '../src/catalog/query.js';

const skill = (id: string, themes: string[], extra: Partial<Skill> = {}): Skill => {
  const [source, name] = id.split('@') as [string, string];
  return { id, name, source, description: `${name} skill`, installs: 10, labels: [], origins: ['skills.sh'], themes, ...extra };
};
const skills = [
  skill('a/b@react-hooks', ['frontend'], { installs: 300 }),
  skill('a/b@tailwind', ['frontend'], { installs: 50, official: true }),
  skill('c/d@pentest', ['security'], { installs: 120 }),
];
const installedNow: InstalledSkill[] = [{ name: 'pentest', source: 'c/d', scope: 'global', agents: ['Claude Code'] }];
const ran: InstallCommand[][] = [];

let server: AtlasServer;
let configDir: string;
const previousConfig = process.env.XDG_CONFIG_HOME;

beforeAll(async () => {
  // apply() remembers the choices: keep them away from the real config.
  configDir = mkdtempSync(join(tmpdir(), 'atlas-web-'));
  process.env.XDG_CONFIG_HOME = configDir;
  server = await startServer({
    skills,
    catalogSkills: skills,
    themes: [
      { id: 'frontend', label: 'Frontend & web' },
      { id: 'security', label: 'Security' },
    ],
    skillsVersion: '1.7.0',
    port: 0,
    cwd: configDir,
    listInstalled: async (scope) => installedNow.filter((s) => s.scope === scope),
    runAll: async (commands, opts = {}) => {
      ran.push(commands);
      const outcomes: CommandOutcome[] = [];
      for (const [i, command] of commands.entries()) {
        opts.onStart?.(command, i);
        opts.onOutput?.('Found 1 skill', i);
        const status = command.kind === 'add' ? 'installed' : 'removed';
        const outcome: CommandOutcome = { command, exitCode: 0, stderr: '', results: command.skills.map((name) => ({ name, status })) };
        outcomes.push(outcome);
        opts.onDone?.(outcome, i);
      }
      return outcomes;
    },
  });
});

afterAll(async () => {
  await server.close();
  if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfig;
  rmSync(configDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;
const get = (path: string, token = server.token) => fetch(base() + path, { headers: { 'x-atlas-token': token } });
const post = (path: string, body: unknown) =>
  fetch(base() + path, { method: 'POST', headers: { 'x-atlas-token': server.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const options = { agents: ['claude-code'], scope: 'project', method: 'symlink' };

describe('web server', () => {
  it('serves and plans curated skills absent from the downloaded catalog', async () => {
    const catalog = withRecommendations({
      version: 1, generatedAt: '2026-10-15', themes: [{ id: 'code', label: 'Code' }], skills: [],
      stats: { raw: { 'skills.sh': 0, smithery: 0, 'claude-plugins.dev': 0 }, merged: 0, byTheme: {} },
    }, [{ name: 'ponytail', repository: 'https://github.com/DietrichGebert/ponytail', reason: 'Keep changes focused.', themes: ['code'] }]);
    const curated = await startServer({
      skills: querySkills(catalog), catalogSkills: catalog.skills, themes: catalog.themes,
      skillsVersion: '1.7.0', port: 0, cwd: configDir, listInstalled: async () => [],
    });
    const headers = { 'x-atlas-token': curated.token };
    const url = `http://127.0.0.1:${curated.port}`;
    try {
      const state = await (await fetch(`${url}/api/state`, { headers })).json();
      expect(state.themes.slice(0, 2).map((th: { id: string }) => th.id)).toEqual(['installed', 'recommended']);
      const page = await (await fetch(`${url}/api/skills?theme=recommended`, { headers })).json();
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({ name: 'ponytail', recommendation: { reason: 'Keep changes focused.' } });
      const plan = await (await fetch(`${url}/api/plan`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ install: ['DietrichGebert/ponytail@ponytail'], remove: [], options }),
      })).json();
      expect(plan.commands).toEqual(['npx -y skills@1.7.0 add DietrichGebert/ponytail -s ponytail -a claude-code -y --json']);
    } finally { await curated.close(); }
  });

  it('serves the page, the token staying in the fragment', async () => {
    expect(server.url).toBe(`${base()}/#${server.token}`);
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Skills Atlas</title>');
  });

  it('refuses API calls without the token or from another host name', async () => {
    expect((await get('/api/state', 'nope')).status).toBe(401);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/', headers: { host: `evil.test:${server.port}` } }, (res) =>
        resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('reports what is installed, the agents and the messages', async () => {
    const state = await (await get('/api/state')).json();
    expect(state.installed).toEqual([expect.objectContaining({ id: 'c/d@pentest', scopes: ['global'], installedName: 'pentest' })]);
    expect(state.themes[0].id).toBe('installed');
    expect(state.agents.some((a: { id: string }) => a.id === 'claude-code')).toBe(true);
    expect(state.messages.applyN).toContain('{n}');
  });

  it('searches, sorts, filters and pages the catalog', async () => {
    const all = await (await get('/api/skills')).json();
    expect(all.items.map((s: Skill) => s.name)).toEqual(['react-hooks', 'pentest', 'tailwind']);
    expect(all.counts).toEqual({ frontend: 2, security: 1 });
    const byName = await (await get('/api/skills?sort=name&theme=frontend')).json();
    expect(byName.items.map((s: Skill) => s.name)).toEqual(['react-hooks', 'tailwind']);
    expect(byName.all).toBe(3);
    const search = await (await get('/api/skills?q=tail')).json();
    expect(search.items.map((s: Skill) => s.name)).toEqual(['tailwind']);
    const official = await (await get('/api/skills?official=1')).json();
    expect(official.total).toBe(1);
    const page = await (await get('/api/skills?limit=1&offset=1')).json();
    expect(page.items.map((s: Skill) => s.name)).toEqual(['pentest']);
    expect(page.total).toBe(3);
  });

  it('plans the same commands as the terminal and rejects what it does not know', async () => {
    const res = await post('/api/plan', { install: ['a/b@tailwind'], remove: ['c/d@pentest'], options });
    const { commands } = await res.json();
    expect(commands).toEqual([
      'npx -y skills@1.7.0 remove -s pentest -y -g',
      'npx -y skills@1.7.0 add a/b -s tailwind -a claude-code -y --json',
    ]);
    expect((await post('/api/plan', { install: ['x/y@nope'], remove: [], options })).status).toBe(400);
    expect((await post('/api/plan', { install: [], remove: ['a/b@tailwind'], options })).status).toBe(400);
    expect((await post('/api/plan', { install: ['a/b@tailwind'], remove: [], options: { ...options, agents: ['nope'] } })).status).toBe(400);
    expect((await post('/api/plan', { install: ['a/b@tailwind'], remove: [], options: { ...options, agents: [] } })).status).toBe(400);
    expect((await post('/api/plan', { install: ['a/b@tailwind; rm -rf /'], remove: [], options })).status).toBe(400);
  });

  it('streams the progress of an install and remembers the choices', async () => {
    const res = await post('/api/apply', { install: ['a/b@tailwind', 'a/b@react-hooks'], remove: [], options });
    expect(res.headers.get('content-type')).toContain('ndjson');
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(['start', 'phase', 'done', 'end']);
    expect(events[1].phase).toBe('installing');
    expect(events.at(-1).ok).toBe(true);
    expect(ran.at(-1)![0]!.skills).toEqual(['tailwind', 'react-hooks']);
    const config = JSON.parse(readFileSync(join(configDir, 'skills-atlas', 'config.json'), 'utf8'));
    expect(config).toMatchObject({ agents: ['claude-code'], scope: 'project', method: 'symlink' });
  });
});
