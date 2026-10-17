import type { InstalledSkill } from '../install/run.js';
import type { Scope, Skill, Theme } from '../types.js';

export const INSTALLED_THEME: Theme = { id: 'installed', label: 'Already installed' };

/** Where an installed skill lives, and the name `skills remove` expects. */
export interface InstalledEntry {
  name: string;
  scopes: Scope[];
  /** Display names of the agents it is installed for, all scopes together. */
  agents: string[];
}

export interface TreeData {
  /** Skills to show, installed ones also listed under `INSTALLED_THEME`. */
  skills: Skill[];
  /** Installed skill ids mapped to their name and scopes. */
  installed: Map<string, InstalledEntry>;
}

/**
 * Merges what is installed (in one scope or both) into the skills shown in
 * the tree. Installed skills are matched to the catalog by `owner/repo@name`
 * (from the lock file); those the catalog does not know, or installed without
 * a recorded source, get a synthetic entry so that they can still be
 * unticked. A skill installed in both scopes appears once, with both scopes.
 * Installed catalog skills hidden by the filters are shown anyway.
 */
export function mergeInstalled(catalogSkills: Skill[], visible: Skill[], installed: InstalledSkill[]): TreeData {
  const key = (source: string, name: string) => `${source.toLowerCase()}@${name.toLowerCase()}`;
  const byKey = new Map(catalogSkills.map((s) => [key(s.source, s.name), s]));
  const shown = new Map(visible.map((s) => [s.id, s]));
  const entries = new Map<string, InstalledEntry>();

  for (const inst of installed) {
    const match = inst.source ? byKey.get(key(inst.source, inst.name)) : undefined;
    const base: Skill = match ?? {
      id: `${inst.source ?? 'local'}@${inst.name}`,
      name: inst.name,
      source: inst.source ?? 'local',
      description: inst.agents.length ? `→ ${inst.agents.join(', ')}` : undefined,
      labels: [],
      origins: [],
      themes: [],
    };
    const entry = entries.get(base.id);
    if (entry) {
      if (!entry.scopes.includes(inst.scope)) entry.scopes.push(inst.scope);
      for (const a of inst.agents) if (!entry.agents.includes(a)) entry.agents.push(a);
      continue;
    }
    entries.set(base.id, { name: inst.name, scopes: [inst.scope], agents: [...inst.agents] });
    shown.set(base.id, { ...base, themes: [INSTALLED_THEME.id, ...base.themes] });
  }
  for (const e of entries.values()) e.scopes.sort((a, b) => (a === 'project' ? -1 : b === 'project' ? 1 : 0));
  return { skills: [...shown.values()], installed: entries };
}
