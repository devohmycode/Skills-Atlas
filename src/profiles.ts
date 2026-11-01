import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Pack } from './catalog/packs.js';
import type { InstalledSkill } from './install/run.js';
import { lockPath, skillDirectories } from './install/scan.js';
import type { Scope } from './types.js';

/**
 * Profiles: a personal pack activated on its own in one scope. Activating one keeps the
 * pack's skills, installs those that are missing and removes every other skill of the
 * scope, home-made ones included. Each activation first saves the whole scope as it is
 * on disk: every skills directory (folders copied, links kept as links) and the lock
 * file, byte for byte. Restoring a backup puts that state back exactly, offline, edited
 * and home-made skills included; it saves the current state first, so it can be undone too.
 * The first backup of a scope is its initial configuration: it is never pruned.
 */

/** Backups kept per scope (and project), besides the initial one. */
const KEEP = 10;

export function backupsRoot(): string {
  const state = process.env.XDG_STATE_HOME?.trim() || join(process.env.HOME || process.env.USERPROFILE || '.', '.local', 'state');
  return join(state, 'skills-atlas', 'backups');
}

const Entry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dir'), name: z.string() }),
  z.object({ kind: z.literal('file'), name: z.string() }),
  z.object({ kind: z.literal('link'), name: z.string(), target: z.string() }),
]);
const Manifest = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  scope: z.enum(['project', 'global']),
  /** The project, for a project backup. */
  cwd: z.string().optional(),
  /** Why it was taken: `profile:<pack id>`, `restore`, `manual`. */
  reason: z.string(),
  initial: z.boolean(),
  /** The skills it holds, for listings: name and source. */
  skills: z.array(z.object({ name: z.string(), source: z.string().optional() })),
  dirs: z.array(z.object({ path: z.string(), exists: z.boolean(), entries: z.array(Entry) })),
  lock: z.object({ path: z.string(), saved: z.boolean() }),
});
export type Backup = z.infer<typeof Manifest>;

const safeName = (name: string) => name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);

function readManifest(dir: string): Backup | undefined {
  try {
    const parsed = Manifest.safeParse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    if (!parsed.success) return undefined;
    // A manifest names entries only: one that would step out of its directory is not a backup we restore.
    if (parsed.data.dirs.some((d) => d.entries.some((e) => !safeName(e.name)))) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

/** The backups of a scope (of this project, for the project scope), newest first. */
export function listBackups(scope?: Scope, cwd = process.cwd(), root = backupsRoot()): Backup[] {
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  return ids
    .map((id) => readManifest(join(root, id)))
    .filter((b): b is Backup => !!b && (!scope || b.scope === scope) && (b.scope === 'global' || b.cwd === resolve(cwd)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/**
 * Saves every skills directory of a scope and its lock file. Returns the backup; prunes
 * the oldest ones beyond KEEP, never the initial one.
 */
export function backupScope(scope: Scope, reason: string, installed: Pick<InstalledSkill, 'name' | 'source'>[], cwd = process.cwd(), root = backupsRoot(), now = new Date()): Backup {
  const previous = listBackups(scope, cwd, root);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let id = `${stamp}-${scope}`;
  for (let i = 2; existsSync(join(root, id)); i++) id = `${stamp}-${scope}-${i}`;
  const dir = join(root, id);
  const tmp = join(root, `.${id}.tmp`);
  mkdirSync(tmp, { recursive: true });
  try {
    const dirs: Backup['dirs'] = [];
    [...skillDirectories(scope, cwd).keys()].forEach((path, i) => {
      const exists = existsSync(path);
      const entries: Backup['dirs'][number]['entries'] = [];
      if (exists) {
        for (const name of readdirSync(path).sort()) {
          const full = join(path, name);
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) entries.push({ kind: 'link', name, target: readlinkSync(full) });
          else if (stat.isDirectory() || stat.isFile()) {
            // Folders are copied as they are, links inside them kept as links.
            cpSync(full, join(tmp, 'dirs', String(i), name), { recursive: true, verbatimSymlinks: true });
            entries.push({ kind: stat.isDirectory() ? 'dir' : 'file', name });
          }
        }
      }
      dirs.push({ path, exists, entries });
    });
    const lock = lockPath(scope, cwd);
    const saved = existsSync(lock);
    if (saved) cpSync(lock, join(tmp, 'lock'));
    const backup: Backup = {
      version: 1, id, createdAt: now.toISOString(), scope, ...(scope === 'project' ? { cwd: resolve(cwd) } : {}), reason,
      initial: previous.length === 0,
      skills: installed.map((s) => ({ name: s.name, ...(s.source ? { source: s.source } : {}) })),
      dirs, lock: { path: lock, saved },
    };
    writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(backup, null, 2)}\n`);
    renameSync(tmp, dir);
    for (const old of previous.filter((b) => !b.initial).slice(KEEP - 1)) rmSync(join(root, old.id), { recursive: true, force: true });
    return backup;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Puts a scope back as a backup saved it: every skills directory holds exactly the
 * entries it held then, and the lock file is the same (or absent, if it was). The
 * current state is saved first; that backup is returned, to undo the restore.
 */
export function restoreBackup(id: string, installed: Pick<InstalledSkill, 'name' | 'source'>[], cwd = process.cwd(), root = backupsRoot()): Backup {
  const dir = join(root, id);
  const backup = readManifest(dir);
  if (!backup || backup.id !== id) throw new Error(`no backup ${id}`);
  const where = backup.scope === 'project' ? backup.cwd! : cwd;
  const undo = backupScope(backup.scope, `restore:${id}`, installed, where, root);
  // Directories the scope has now but the backup did not know (an agent added since) are emptied too.
  const known = new Set(backup.dirs.map((d) => d.path));
  const extra = [...skillDirectories(backup.scope, where).keys()].filter((p) => !known.has(p)).map((path) => ({ path, exists: false, entries: [] }));
  for (const [i, d] of [...backup.dirs.entries(), ...extra.map((d) => [-1, d] as const)]) {
    if (existsSync(d.path)) {
      for (const name of readdirSync(d.path)) rmSync(join(d.path, name), { recursive: true, force: true });
    }
    if (!d.entries.length) continue;
    mkdirSync(d.path, { recursive: true });
    for (const e of d.entries) {
      const to = join(d.path, e.name);
      if (e.kind === 'link') symlinkSync(e.target, to, 'dir');
      else cpSync(join(dir, 'dirs', String(i), e.name), to, { recursive: true, verbatimSymlinks: true });
    }
  }
  const lock = backup.lock.path;
  if (backup.lock.saved) {
    mkdirSync(dirname(lock), { recursive: true });
    cpSync(join(dir, 'lock'), lock);
  } else rmSync(lock, { force: true });
  return undo;
}

/** What activating a pack as a profile does in a scope: what stays, what goes, what comes. */
export interface ProfilePlan {
  keep: string[];
  /** Installed skills of the scope outside the pack, by name (home-made ones too). */
  remove: { name: string; id: string }[];
  /** Pack skills the scope does not have yet. */
  install: string[];
}

export function profilePlan(pack: Pick<Pack, 'skills'>, installed: Pick<InstalledSkill, 'name' | 'source'>[]): ProfilePlan {
  const wanted = new Map(pack.skills.map((id) => [id.toLowerCase(), id]));
  const id = (s: Pick<InstalledSkill, 'name' | 'source'>) => `${s.source ?? 'local'}@${s.name}`;
  const keep = installed.filter((s) => wanted.has(id(s).toLowerCase())).map(id);
  const have = new Set(keep.map((k) => k.toLowerCase()));
  return {
    keep,
    remove: installed.filter((s) => !wanted.has(id(s).toLowerCase())).map((s) => ({ name: s.name, id: id(s) })),
    install: [...wanted.values()].filter((w) => !have.has(w.toLowerCase())),
  };
}
