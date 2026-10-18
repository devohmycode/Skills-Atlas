/** `source@name`, split at the last `@`: installed ids may be `local@name`, which is no `owner/repo`. */
const split = (id: string) => ({ source: id.slice(0, id.lastIndexOf('@')), name: id.slice(id.lastIndexOf('@') + 1) });

/** A skill that would take the folder of another one: the skills CLI installs by name. */
export interface Collision {
  name: string;
  /** The skill being installed (`owner/repo@name`). */
  incoming: string;
  /** The skill it replaces: installed in that scope, or selected earlier in the same run. */
  replaced: string;
  installed: boolean;
}

/**
 * Skills to install whose name is already taken, in the target scope, by a skill
 * from another source, or by another selected skill: one folder per name, so the
 * later one silently replaces the earlier one. A skill from the same repository
 * is a reinstall, not a collision. Installed skills without a known source
 * (home-made, `local@…`) count as another source.
 */
export function nameCollisions(ids: string[], installedIds: string[]): Collision[] {
  const holder = new Map<string, { id: string; installed: boolean }>();
  for (const id of installedIds) holder.set(split(id).name.toLowerCase(), { id, installed: true });
  const out: Collision[] = [];
  for (const id of ids) {
    const { source, name } = split(id);
    const key = name.toLowerCase();
    const current = holder.get(key);
    if (current && split(current.id).source.toLowerCase() !== source.toLowerCase()) {
      out.push({ name, incoming: id, replaced: current.id, installed: current.installed });
    }
    holder.set(key, { id, installed: false });
  }
  return out;
}
