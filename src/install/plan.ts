import { SCOPES, type InstallOptions, type Removal, type Scope } from '../types.js';

export interface InstallCommand {
  kind: 'add' | 'remove';
  /** `owner/repo` for `add`; empty for `remove`, which works on installed names. */
  source: string;
  skills: string[];
  /** Arguments passed to `npx`. */
  args: string[];
  /** Scope the command works on, used to check removals afterwards. */
  scope: Scope;
}

/** Splits `owner/repo@skill` into its source and skill name. */
export function parseSkillId(id: string): { source: string; name: string } {
  const at = id.lastIndexOf('@');
  if (at <= 0 || at === id.length - 1) throw new Error(`invalid skill id "${id}" — expected owner/repo@skill`);
  const source = id.slice(0, at);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    throw new Error(`invalid source "${source}" in "${id}" — expected owner/repo`);
  }
  return { source, name: id.slice(at + 1) };
}

/**
 * Groups the selected skills by source repository and builds one
 * `npx skills add` call per repository.
 *
 * The source goes first because `-s` and `-a` are variadic in the skills CLI:
 * everything after them up to the next flag is taken as a value. `-a` is
 * always passed — without it `-y` installs to every detected agent.
 */
export function planInstall(ids: string[], opts: InstallOptions): InstallCommand[] {
  if (opts.agents.length === 0) throw new Error('at least one agent is required');
  const bySource = new Map<string, string[]>();
  for (const id of ids) {
    const { source, name } = parseSkillId(id);
    const list = bySource.get(source) ?? [];
    if (!list.includes(name)) list.push(name);
    bySource.set(source, list);
  }
  return [...bySource.entries()].map(([source, skills]) => {
    const args = ['-y', `skills@${opts.skillsVersion}`, 'add', source, '-s', ...skills, '-a', ...opts.agents];
    if (opts.scope === 'global') args.push('-g');
    if (opts.method === 'copy') args.push('--copy');
    args.push('-y', '--json');
    return { kind: 'add' as const, source, skills, args, scope: opts.scope };
  });
}

/**
 * One `npx skills remove` call for every skill to uninstall. Without `-a` the
 * skills CLI removes them from every agent of the scope, which is what
 * unticking an installed skill means.
 */
export function planRemove(names: string[], opts: { scope: Scope; skillsVersion: string }): InstallCommand[] {
  const skills = [...new Set(names)];
  if (skills.length === 0) return [];
  const args = ['-y', `skills@${opts.skillsVersion}`, 'remove', '-s', ...skills, '-y'];
  if (opts.scope === 'global') args.push('-g');
  return [{ kind: 'remove', source: '', skills, args, scope: opts.scope }];
}

/** One `npx skills remove` call per scope holding skills to uninstall (project first). */
export function planRemovals(removals: Removal[], skillsVersion: string): InstallCommand[] {
  return SCOPES.flatMap((scope) =>
    planRemove(
      removals.filter((r) => r.scopes.includes(scope)).map((r) => r.name),
      { scope, skillsVersion },
    ),
  );
}

/** Shell-like rendering of a command, for `--dry-run` and confirmations. */
export function formatCommand(cmd: InstallCommand): string {
  const quote = (a: string) => (/^[\w@./:=*-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return ['npx', ...cmd.args].map(quote).join(' ');
}
