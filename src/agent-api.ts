import { AGENTS } from './agents.js';
import { querySkills } from './catalog/query.js';
import { auditSkills, withLookalikes } from './audit.js';
import { fetchSkillFiles, fetchSkillMarkdown, githubUrl } from './github.js';
import { parseSkillId } from './install/plan.js';
import { listInstalled } from './install/run.js';
import { checkUpdates, type UpdateCheck } from './install/updates.js';
import { folderCost, markdownCost, type SkillCost } from './context.js';
import { projectRevisionDrift } from './revisions.js';
import type { Risk } from './risks.js';
import { missingSkills, missingSkillsByAgent } from './selection.js';
import { detectStack, suggestSkills } from './suggest.js';
import { SCOPES, type Catalog, type Scope, type Skill } from './types.js';

/**
 * What an agent (the CLI's non-interactive commands, the MCP server) can ask
 * of skills-atlas, as plain data: search, read a SKILL.md, list what is
 * installed or outdated.
 */

/** A skill as an agent needs it to choose: no internal fields. */
export interface SkillSummary {
  id: string;
  name: string;
  source: string;
  description?: string;
  installs?: number;
  official?: boolean;
  recommended?: boolean;
  themes: string[];
  url?: string;
  requires?: { bins?: string[]; compatibility?: string };
  updated_at?: string;
  license?: string;
  archived?: boolean;
  last_push?: string;
}

export function summarize(s: Skill): SkillSummary {
  return {
    id: s.id, name: s.name, source: s.source, description: s.description, installs: s.installs,
    official: s.official || undefined, recommended: s.recommendation ? true : undefined, themes: s.themes, url: githubUrl(s),
    requires: s.requires, updated_at: s.updatedAt,
    license: s.repo?.license, archived: s.repo?.archived, last_push: s.repo?.pushedAt,
  };
}

/** Agent ids from the display names the installed-skill scan reports; unknown names are dropped. */
export function agentIds(names: string[]): string[] {
  return [...new Set(names.map((n) => AGENTS.find((a) => a.displayName === n)?.id).filter((id): id is string => !!id))];
}

/** Search matches ranked by relevance, with popularity breaking ties. */
export function searchSkills(catalog: Catalog, opts: { query?: string; theme?: string; official?: boolean; limit?: number } = {}): SkillSummary[] {
  const found = querySkills(catalog, { search: opts.query, themes: opts.theme ? [opts.theme] : undefined, official: opts.official });
  return found.slice(0, opts.limit ?? 20).map(summarize);
}

/** The catalog entry for an id (any case), or a bare one built from the id for a skill the catalog does not know. */
export function findSkill(catalog: Catalog, id: string): Skill {
  const known = catalog.skills.find((s) => s.id.toLowerCase() === id.toLowerCase());
  if (known) return known;
  const { source, name } = parseSkillId(id);
  return { id, name, source, labels: [], origins: [], themes: [] };
}

/** A skill's SKILL.md, from its GitHub repository (escape sequences removed), and the warning signs of its folder. */
export async function showSkill(catalog: Catalog, id: string): Promise<{ skill: SkillSummary; markdown: string; risks: Risk[]; cost: SkillCost }> {
  const skill = findSkill(catalog, id);
  const markdown = await fetchSkillMarkdown(skill);
  // The audit's view: the other files of the folder too, the SKILL.md read once.
  const [audit] = withLookalikes(await auditSkills([skill], async () => markdown, fetchSkillFiles), catalog.skills);
  return { skill: summarize(skill), markdown, risks: audit!.risks, cost: markdownCost(markdown, skill.name) };
}

/** An installed skill, with the agent ids an install command needs. */
export interface InstalledSummary {
  id: string;
  name: string;
  source?: string;
  scope: Scope;
  agents: string[];
  /** Estimated context cost, when asked for: tokens at startup and when used, files and bytes on disk. */
  cost?: SkillCost;
}

export async function installedSkills(scopes: Scope[], opts: { cost?: boolean } = {}): Promise<InstalledSummary[]> {
  const found = (await Promise.all(scopes.map((sc) => listInstalled(sc)))).flat();
  return found.map((s) => {
    const cost = opts.cost && s.path ? folderCost(s.path, s.name) : undefined;
    return { id: `${s.source ?? 'local'}@${s.name}`, name: s.name, source: s.source, scope: s.scope, agents: agentIds(s.agents), ...(cost ? { cost } : {}) };
  });
}

/**
 * The installed skills each agent sees, agents by name, skills by name. A skill
 * in the shared `.agents/skills` directory shows under every agent that reads it.
 */
export function skillsByAgent(installed: InstalledSummary[]): { agent: string; name: string; skills: InstalledSummary[] }[] {
  const byAgent = new Map<string, InstalledSummary[]>();
  for (const s of installed) for (const a of s.agents) byAgent.set(a, [...(byAgent.get(a) ?? []), s]);
  return [...byAgent]
    .map(([agent, skills]) => ({ agent, name: AGENTS.find((a) => a.id === agent)?.displayName ?? agent, skills: skills.sort((x, y) => x.name.localeCompare(y.name)) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Installed skills with a newer version on GitHub, in the project and global
 * scopes (or the ones asked). Updating one is installing it again in its scope:
 * `skills-atlas install <id> -g|-p -a <its agents> -y`. `unchecked` lists what
 * could not be checked: the check is complete only when it is empty. `modified`
 * names the project skills edited by hand, which are left out of the updates.
 */
export async function outdatedSkills(scopes: Scope[] = ['project', 'global']): Promise<{ skills: InstalledSummary[]; unchecked: UpdateCheck['unchecked']; modified: string[] }> {
  const [found, installed] = await Promise.all([checkUpdates(scopes), installedSkills(scopes)]);
  return {
    skills: installed.filter((s) => s.source && found.outdated[s.scope].has(`${s.source}@${s.name}`.toLowerCase())),
    unchecked: found.unchecked,
    modified: found.modified,
  };
}

/** A technology found in the project and the skills suggested for it, as an agent reads them. */
export interface StackSummary {
  id: string;
  label: string;
  evidence: string[];
  skills: SkillSummary[];
}

/**
 * Skills that fit the project in `dir`: what its manifests and files say it uses,
 * then catalog skills for each of those, without the ones installed there or globally.
 * Reads files only; nothing is installed or sent anywhere.
 */
export async function suggestForProject(catalog: Catalog, dir = process.cwd(), opts: { perStack?: number } = {}): Promise<{ stack: StackSummary[]; packs: string[] }> {
  const installed = (await Promise.all(SCOPES.map((sc) => listInstalled(sc, dir)))).flat();
  const found = suggestSkills(catalog, detectStack(dir), { installed: installed.map((s) => `${s.source ?? 'local'}@${s.name}`), perStack: opts.perStack });
  return { stack: found.stack.map((s) => ({ id: s.id, label: s.label, evidence: s.evidence, skills: s.skills.map(summarize) })), packs: found.packs };
}

/** What `sync` would install: groups of ids, each for its agents (all of the file's agents, or project-wide presence). */
export interface SyncPlan {
  ids: string[];
  agents?: string[];
  revisions?: Record<string, string>;
  groups: { agents: string[] | undefined; ids: string[] }[];
}

/**
 * The skills of a project's `skills-atlas.json` that are missing in the project: per
 * target agent when agents are given (or the file names some), else by presence. Pinned
 * skills whose installed files drifted from their revision are reinstalled too.
 */
export async function projectSyncPlan(file: { ids: string[]; agents?: string[]; revisions?: Record<string, string> }, targets: string[] | undefined, cwd = process.cwd()): Promise<SyncPlan> {
  const installed = await listInstalled('project', cwd);
  const groups: SyncPlan['groups'] = targets
    ? missingSkillsByAgent(file.ids, installed, targets)
    : [{ agents: undefined, ids: missingSkills(file.ids, installed.map((s) => `${s.source ?? 'local'}@${s.name}`)) }];
  const drift = (await projectRevisionDrift(file.ids, file.revisions ?? {}, installed, cwd)).filter((id) => !groups.some((g) => g.ids.includes(id)));
  if (drift.length) groups.push({ agents: targets, ids: drift });
  return { ids: file.ids, agents: targets, revisions: file.revisions, groups: groups.filter((g) => g.ids.length) };
}
