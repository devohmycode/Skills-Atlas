import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { AGENTS, detectAgents, unknownAgents } from '../agents.js';
import { INSTALLED_THEME, mergeInstalled, type InstalledEntry } from '../catalog/installed.js';
import { PackSaveError, packTheme, savePack } from '../catalog/packs.js';
import { byGrowth } from '../catalog/trending.js';
import { createSearchIndex, SORT_ORDERS } from '../catalog/query.js';
import { readConfig, writeConfig } from '../config.js';
import { auditEnabled, auditSkills, failsAudit } from '../audit.js';
import { fetchSkillMarkdown } from '../github.js';
import { scanRisks } from '../risks.js';
import { nameCollisions } from '../install/collisions.js';
import { getLang, locale, t, themeLabel } from '../i18n/index.js';
import { formatCommand, planInstall, planRemovals, type InstallCommand } from '../install/plan.js';
import { isSuccess, listInstalled, phaseOf, runAll, type CommandOutcome, type InstalledSkill, type Phase } from '../install/run.js';
import { SCOPES, type Catalog, type InstallOptions, type Removal, type Scope, type Skill, type Theme } from '../types.js';
import { PAGE_HTML } from './page.js';
export { openBrowser } from '../browser.js';

export interface ServerOptions {
  /** Skills to browse (already filtered like the tree: `querySkills`). */
  skills: Skill[];
  /** Every catalog skill, to recognise installed ones hidden by the filters. */
  catalogSkills: Skill[];
  themes: Theme[];
  sources?: Catalog['stats']['sources'];
  skillsVersion: string;
  /** Default: DEFAULT_PORT, or a free one when it is taken; 0 always picks a free one. */
  port?: number;
  /** Project directory for the project scope. */
  cwd?: string;
  /** Injected in tests, so that nothing is installed for real. */
  listInstalled?: (scope: 'project' | 'global', cwd?: string) => Promise<InstalledSkill[]>;
  runAll?: typeof runAll;
  readSkill?: typeof fetchSkillMarkdown;
  /** Personal pack destination; injected tests never touch the user profile. */
  packsPath?: string;
}

export interface AtlasServer {
  /** Address to open, token included. */
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

export const DEFAULT_PORT = 4747;
/** Largest page of skills a request may ask for. */
const MAX_LIMIT = 500;
/** Largest JSON body accepted. */
const MAX_BODY = 1_000_000;

const Body = z.object({
  install: z.array(z.string()).max(2000),
  remove: z.array(z.string()).max(2000),
  auditOverrides: z.array(z.string()).max(2000).default([]),
  options: z.object({
    agents: z.array(z.string()).max(100),
    scope: z.enum(['project', 'global']),
    method: z.enum(['symlink', 'copy']),
  }),
  /** Install only the requested agents that do not have the skill yet in the scope. */
  retry: z.boolean().optional(),
});

/** Agent ids from the display names the installed-skill scan reports. */
const agentIds = (names: string[]) => names.map((n) => AGENTS.find((a) => a.displayName === n || a.id === n)?.id ?? n);

/** Fields of a skill the page needs. */
const slim = (s: Skill) => ({
  id: s.id,
  name: s.name,
  source: s.source,
  description: s.description,
  labels: s.labels,
  installs: s.installs,
  stars: s.stars,
  rank: s.rank,
  growth: s.growth,
  official: s.official,
  recommendation: s.recommendation,
  themes: s.themes,
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Local web interface: the same catalog, detection and install commands as the terminal tree,
 * served on 127.0.0.1 only. Every API call must carry the random token of the URL (header
 * `x-atlas-token`) and a local Host, so that no other web page can drive installs.
 */
export async function startServer(opts: ServerOptions): Promise<AtlasServer> {
  const cwd = opts.cwd ?? process.cwd();
  const list = opts.listInstalled ?? listInstalled;
  const run = opts.runAll ?? runAll;
  const readSkill = opts.readSkill ?? fetchSkillMarkdown;
  const token = randomBytes(24).toString('hex');
  let skills = opts.skills;
  let themes = opts.themes;
  let catalogSkills = opts.catalogSkills;
  const catalogIds = new Set(catalogSkills.map((s) => s.id));
  let search = createSearchIndex(skills);
  let queryCache: { key: string; matching: Skill[]; counts: Record<string, number> } | undefined;
  let running = false;

  /**
   * What is installed now, in both scopes, merged into the catalog like the tree does,
   * with the agent ids that have each skill in each scope.
   */
  async function installed() {
    const found = await Promise.all(SCOPES.map((sc) => list(sc, cwd)));
    const coverage = new Map<string, Partial<Record<Scope, string[]>>>();
    SCOPES.forEach((sc, i) => {
      for (const [id, e] of mergeInstalled(catalogSkills, [], found[i]!).installed) {
        coverage.set(id, { ...coverage.get(id), [sc]: agentIds(e.agents) });
      }
    });
    return { ...mergeInstalled(catalogSkills, skills, found.flat()), coverage };
  }

  function replacements(ids: string[], entries: Map<string, InstalledEntry>, scope: 'project' | 'global') {
    return nameCollisions(ids, [...entries].filter(([, e]) => e.scopes.includes(scope)).map(([id]) => id))
      .map((c) => ({ ...c, message: t().confirm.replaces(c.incoming, c.replaced, c.installed) }));
  }

  async function state() {
    const inst = await installed();
    const config = readConfig();
    const detected = new Set(detectAgents().map((a) => a.id));
    const detectedList = AGENTS.filter((a) => detected.has(a.id)).map((a) => a.id);
    const byId = new Map(inst.skills.map((s) => [s.id, s]));
    return {
      lang: getLang(),
      locale: locale(),
      sources: opts.sources,
      messages: { ...t().web, risks: t().tree.risks, riskLevels: t().tree.riskLevels,
        noRisk: t().tree.noRisk, previewLoading: t().tree.previewLoading,
        auditOff: t().confirm.auditOff, auditUnread: t().confirm.auditUnread, auditToggle: t().confirm.auditToggle },
      cwd,
      skillsVersion: opts.skillsVersion,
      canSavePacks: true,
      themes: [INSTALLED_THEME, ...themes].map((th) => ({ id: th.id, label: themeLabel(th), description: th.description, pack: th.pack })),
      agents: AGENTS.map((a) => ({ id: a.id, name: a.displayName, detected: detected.has(a.id) })),
      defaults: {
        agents: config.agents?.length ? config.agents : detectedList,
        scope: config.scope ?? 'project',
        method: config.method ?? 'symlink',
      },
      installed: [...inst.installed].map(([id, e]) => ({ ...slim(byId.get(id)!), installedName: e.name, scopes: e.scopes, agentsByScope: inst.coverage.get(id) ?? {}, catalog: catalogIds.has(id) })),
    };
  }

  function skillsPage(params: URLSearchParams) {
    const query = params.get('q') ?? '';
    const sort = SORT_ORDERS.find((o) => o === params.get('sort')) ?? (query.trim() ? undefined : 'installs');
    const official = params.get('official') === '1';
    const theme = params.get('theme') || undefined;
    const offset = Math.max(0, Number(params.get('offset')) || 0);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit')) || 100));
    // Paging and switching themes keep the same search: scan the catalog once for both.
    const key = JSON.stringify([sort, query, official]);
    if (queryCache?.key !== key) {
      const matching = search(query, sort).filter((s) => !official || s.official);
      const counts: Record<string, number> = {};
      for (const s of matching) for (const th of s.themes) counts[th] = (counts[th] ?? 0) + 1;
      queryCache = { key, matching, counts };
    }
    const { matching, counts } = queryCache;
    const inTheme = theme === 'trending' && !query.trim() ? byGrowth(matching.filter((s) => s.themes.includes(theme))) : theme ? matching.filter((s) => s.themes.includes(theme)) : matching;
    return { total: inTheme.length, all: matching.length, counts, items: inTheme.slice(offset, offset + limit).map(slim) };
  }

  /** Checks a request body against the catalog and what is installed, then plans the commands. */
  async function plan(raw: unknown) {
    const parsed = Body.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'invalid request');
    const { install: requested, remove, options, auditOverrides, retry } = parsed.data;
    const install = [...new Set(requested)];
    if (auditOverrides.some((id) => !install.includes(id))) throw new HttpError(400, 'invalid audit overrides');
    const inst = await installed();
    const unknown = install.filter((id) => !catalogIds.has(id));
    if (unknown.length) throw new HttpError(400, `unknown skills: ${unknown.join(', ')}`);
    const notInstalled = remove.filter((id) => !inst.installed.has(id));
    if (notInstalled.length) throw new HttpError(400, `not installed: ${notInstalled.join(', ')}`);
    if (install.length && !options.agents.length) throw new HttpError(400, t().web.needAgent);
    const badAgents = unknownAgents(options.agents);
    if (badAgents.length) throw new HttpError(400, `unknown agents: ${badAgents.join(', ')}`);
    const enabled = auditEnabled(readConfig());
    const byId = new Map(catalogSkills.map((s) => [s.id, s]));
    const results = enabled ? await auditSkills(install.map((id) => byId.get(id)!), readSkill) : [];
    const failing = results.filter(failsAudit).map((r) => r.id);
    if (auditOverrides.some((id) => !failing.includes(id))) throw new HttpError(400, 'invalid audit overrides');
    const blocked = failing.filter((id) => !auditOverrides.includes(id));
    const allowed = install.filter((id) => !blocked.includes(id));
    const collisions = replacements(install, inst.installed, options.scope);
    const full: InstallOptions = { ...options, skillsVersion: opts.skillsVersion };
    const removals: Removal[] = remove.map((id) => {
      const e = inst.installed.get(id) as InstalledEntry;
      return { name: e.name, scopes: [...e.scopes] };
    });
    let installs: InstallCommand[] = [];
    if (retry) {
      // A partial install leaves some agents without the skill: plan only those, grouped by agent set.
      const byAgents = new Map<string, { agents: string[]; ids: string[] }>();
      for (const id of allowed) {
        const have = new Set(inst.coverage.get(id)?.[options.scope] ?? []);
        const missing = options.agents.filter((a) => !have.has(a));
        if (!missing.length) continue;
        const key = missing.join(' ');
        const group = byAgents.get(key) ?? { agents: missing, ids: [] };
        group.ids.push(id);
        byAgents.set(key, group);
      }
      installs = [...byAgents.values()].flatMap((g) => planInstall(g.ids, { ...full, agents: g.agents }));
    } else if (allowed.length) installs = planInstall(allowed, full);
    const commands = [...planRemovals(removals, opts.skillsVersion), ...installs];
    return { commands, options: full, installs: installs.length, blocked, audit: { enabled, results }, collisions };
  }

  /** Runs the plan, streaming one JSON line per event: start, phase, done, then end. */
  async function apply(raw: unknown, res: ServerResponse) {
    const { commands, options, installs, blocked, audit, collisions } = await plan(raw);
    if (blocked.length) throw new HttpError(409, `${t().web.auditBlocked}: ${blocked.join(', ')}`);
    if (!commands.length) throw new HttpError(400, 'nothing to do');
    if (running) throw new HttpError(409, t().web.busy);
    running = true;
    // Same memory as the terminal: the next run starts from these choices.
    if (installs) writeConfig({ ...readConfig(), agents: options.agents, scope: options.scope, method: options.method });
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const send = (event: object) => res.write(`${JSON.stringify(event)}\n`);
    send({ type: 'audit', audit, collisions });
    const phases = commands.map((): Phase => 'queued');
    const stderr = commands.map(() => '');
    try {
      const outcomes: CommandOutcome[] = await run(commands, {
        cwd,
        onStart: (c, i) => send({ type: 'start', i, kind: c.kind, source: c.source, skills: c.skills, command: formatCommand(c) }),
        onOutput: (text, i) => {
          stderr[i] = (stderr[i]! + text).slice(-4000);
          const next = phaseOf(stderr[i]!, phases[i]!);
          if (next !== phases[i]) send({ type: 'phase', i, phase: (phases[i] = next) });
        },
        onDone: (o, i) =>
          send({ type: 'done', i, ok: isSuccess(o), results: o.results, error: isSuccess(o) ? undefined : o.stderr.slice(-800) }),
      });
      send({ type: 'end', ok: outcomes.every(isSuccess) });
    } catch (err) {
      send({ type: 'end', ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
      res.end();
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError || err instanceof PackSaveError ? err.status : 500;
      if (res.headersSent) return res.end();
      json(req, res, { error: err instanceof Error ? err.message : String(err) }, status);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const port = (server.address() as AddressInfo).port;
    // DNS rebinding: a page on another host name resolving to 127.0.0.1 is refused.
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
      throw new HttpError(403, 'forbidden host');
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:",
        'x-frame-options': 'DENY',
      });
      return res.end(PAGE_HTML);
    }
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (!validToken(req.headers['x-atlas-token'])) throw new HttpError(401, 'bad token');
    if (req.method === 'GET' && url.pathname === '/api/state') return json(req, res, await state());
    if (req.method === 'GET' && url.pathname === '/api/skills') return json(req, res, skillsPage(url.searchParams));
    if (req.method === 'GET' && url.pathname === '/api/preview') {
      const id = url.searchParams.get('id');
      const scope = url.searchParams.get('scope') ?? 'project';
      if (scope !== 'project' && scope !== 'global') throw new HttpError(400, 'invalid scope');
      const inst = await installed();
      const skill = catalogSkills.find((s) => s.id === id) ?? inst.skills.find((s) => s.id === id);
      if (!skill) throw new HttpError(404, 'unknown skill');
      const collisions = replacements([skill.id], inst.installed, scope);
      try {
        const markdown = await readSkill(skill);
        return json(req, res, { id: skill.id, markdown, risks: scanRisks(markdown), collisions });
      } catch (err) {
        return json(req, res, { id: skill.id, risks: [], collisions, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/packs') {
      const pack = savePack(await readJson(req), catalogSkills, opts.packsPath);
      const theme = packTheme(pack.id);
      const ids = new Set(pack.skills);
      const decorate = (s: Skill) => ids.has(s.id) ? { ...s, themes: [...new Set([...s.themes, theme])] } : s;
      skills = skills.map(decorate);
      catalogSkills = catalogSkills.map(decorate);
      const after = Math.max(...themes.map((th, i) => th.id.startsWith('pack:') || th.id === 'recommended' || th.id === 'trending' ? i : -1)) + 1;
      themes = [...themes.slice(0, after), { id: theme, label: `📦 ${pack.name}`, description: pack.description }, ...themes.slice(after)];
      search = createSearchIndex(skills);
      queryCache = undefined;
      return json(req, res, { pack }, 201);
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const { commands, audit, blocked, collisions } = await plan(await readJson(req));
      return json(req, res, { commands: commands.map(formatCommand), audit, blocked, collisions });
    }
    if (req.method === 'POST' && url.pathname === '/api/apply') return apply(await readJson(req), res);
    throw new HttpError(404, 'not found');
  }

  function validToken(value: string | string[] | undefined): boolean {
    if (typeof value !== 'string' || value.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(value), Buffer.from(token));
  }

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  if (opts.port !== undefined) await listen(opts.port);
  else {
    // A stable port keeps the same origin between runs, so the page remembers its theme.
    await listen(DEFAULT_PORT).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') throw err;
      return listen(0);
    });
  }
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/#${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function json(req: IncomingMessage, res: ServerResponse, body: unknown, status = 200) {
  let data: Buffer = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (data.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    data = gzipSync(data);
    headers['content-encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'expected JSON');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}
