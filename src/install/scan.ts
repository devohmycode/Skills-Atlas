import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AGENTS, expandHome } from '../agents.js';
import type { Scope } from '../types.js';
import type { InstalledSkill } from './run.js';

/** Canonical directory where the skills CLI keeps skills (and universal agents read them). */
function canonicalDir(scope: Scope, cwd: string): string {
  return scope === 'global' ? expandHome('~/.agents/skills') : join(cwd, '.agents', 'skills');
}

/** Lock file written by the skills CLI: global (`~/.agents/.skill-lock.json`) or project (`skills-lock.json`). */
export function lockPath(scope: Scope, cwd: string): string {
  if (scope === 'project') return join(cwd, 'skills-lock.json');
  const state = process.env.XDG_STATE_HOME?.trim();
  return state ? join(state, 'skills', '.skill-lock.json') : expandHome('~/.agents/.skill-lock.json');
}

/** `skill name → owner/repo` from the lock file; empty when there is none. */
export function readLockSources(path: string): Map<string, string> {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as { skills?: Record<string, { source?: unknown }> };
    const out = new Map<string, string>();
    for (const [name, entry] of Object.entries(lock.skills ?? {})) {
      if (typeof entry.source === 'string' && /^[\w.-]+\/[\w.-]+$/.test(entry.source)) out.set(name.toLowerCase(), entry.source);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** `name` from a SKILL.md frontmatter, without a YAML parser. */
export function frontmatterName(markdown: string): string | undefined {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  const raw = fm && /^name\s*:\s*(.+?)\s*$/m.exec(fm)?.[1];
  return raw ? raw.replace(/^(["'])(.*)\1$/, '$2').trim() || undefined : undefined;
}

/** Skill directories (or links to one) holding a SKILL.md, with the skill's name. */
function readSkillsDir(dir: string): { name: string; path: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; path: string }[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const skillMd = join(path, 'SKILL.md');
    try {
      // statSync follows symlinks, which is how the skills CLI links agents to the canonical copy.
      if (!statSync(path).isDirectory() || !existsSync(skillMd)) continue;
      out.push({ name: frontmatterName(readFileSync(skillMd, 'utf8')) ?? entry, path });
    } catch {
      // Broken link or unreadable file: not an installed skill.
    }
  }
  return out;
}

/** Unique skills directories of a scope and the agents that read each directory. */
export function skillDirectories(scope: Scope, cwd: string): Map<string, string[]> {
  // Directory → agents reading it (several agents share `.agents/skills`).
  const dirs = new Map<string, string[]>();
  const add = (dir: string, agent?: string) => {
    const key = resolve(dir);
    const list = dirs.get(key) ?? [];
    if (agent && !list.includes(agent)) list.push(agent);
    dirs.set(key, list);
  };
  add(canonicalDir(scope, cwd));
  for (const agent of AGENTS) {
    if (scope === 'global') {
      if (agent.globalDir) add(expandHome(agent.globalDir), agent.displayName);
    } else add(join(cwd, agent.projectDir), agent.displayName);
  }

  return dirs;
}

/** Installed skills read from the canonical/agent directories and their lock sources, without npx. */
export function scanInstalled(scope: Scope, cwd = process.cwd()): InstalledSkill[] {
  const dirs = skillDirectories(scope, cwd);
  const sources = readLockSources(lockPath(scope, cwd));
  const skills = new Map<string, InstalledSkill>();
  for (const [dir, agents] of dirs) {
    for (const found of readSkillsDir(dir)) {
      const key = found.name.toLowerCase();
      const skill = skills.get(key) ?? {
        name: found.name,
        source: sources.get(key),
        scope,
        agents: [],
        path: found.path,
      };
      for (const a of agents) if (!skill.agents.includes(a)) skill.agents.push(a);
      skills.set(key, skill);
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A project may have canonical files and independent copies for several agents.
 * Directories named after the skill are included whatever their SKILL.md says
 * (or lacks), so an edited or broken copy is still verified instead of vanishing.
 */
export function installedSkillPaths(scope: Scope, cwd: string, name: string): string[] {
  const dirs = new Set([canonicalDir(scope, cwd)]);
  for (const agent of AGENTS) {
    if (scope === 'project') dirs.add(join(cwd, agent.projectDir));
    else if (agent.globalDir) dirs.add(expandHome(agent.globalDir));
  }
  const wanted = name.toLowerCase();
  const named = (dir: string) => {
    try {
      return readdirSync(dir).filter(entry => entry.toLowerCase() === wanted).map(entry => join(dir, entry));
    } catch {
      return [];
    }
  };
  return [...new Set([...dirs].flatMap(dir => [...named(dir), ...readSkillsDir(dir).filter(s => s.name.toLowerCase() === wanted).map(s => s.path)]))];
}
