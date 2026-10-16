import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Scope } from '../types.js';
import type { InstallCommand } from './plan.js';
import { scanInstalled } from './scan.js';

/** One entry of the array printed by `skills add --json`. */
export interface SkillResult {
  name?: string;
  status: 'installed' | 'skipped' | 'failed' | 'removed';
  source?: string;
  path?: string;
  scope?: 'project' | 'global';
  agents?: string[];
  mode?: string;
  reason?: string;
  error?: string;
}

export interface CommandOutcome {
  command: InstallCommand;
  exitCode: number;
  results: SkillResult[];
  /** Tail of stderr, kept for failures. */
  stderr: string;
}

/** One entry of `skills list --json`. */
export interface InstalledSkill {
  name: string;
  /** `owner/repo` when the skill came from GitHub, per the lock file. */
  source?: string;
  scope: Scope;
  /** Agent display names (`Claude Code`, `Codex`…). */
  agents: string[];
  path?: string;
}

/**
 * Resolves how to launch npx without a shell. On Windows `npx` is a `.cmd`
 * shim that Node refuses to spawn directly, so we run npm's `npx-cli.js` with
 * the current Node binary; a shell is only the last resort.
 */
function npxLauncher(): { file: string; prefix: string[]; shell: boolean } {
  if (process.platform !== 'win32') return { file: 'npx', prefix: [], shell: false };
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (existsSync(cli)) return { file: process.execPath, prefix: [cli], shell: false };
  return { file: 'npx.cmd', prefix: [], shell: true };
}

export interface NpxRun {
  exitCode: number;
  stdout: string;
  /** Tail of stderr. */
  stderr: string;
}

/** Runs `npx <args>` without a shell, capturing its output. */
export function runNpx(
  npxArgs: string[],
  opts: { cwd?: string; verbose?: boolean; onStderr?: (text: string) => void } = {},
): Promise<NpxRun> {
  const { file, prefix, shell } = npxLauncher();
  const args = [...prefix, ...npxArgs];
  return new Promise((resolve) => {
    const child = spawn(file, shell ? args.map((a) => `"${a}"`) : args, {
      cwd: opts.cwd,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
      if (opts.verbose) process.stderr.write(d);
      opts.onStderr?.(d.toString());
    });
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

/** Extracts the JSON array from stdout, ignoring any stray line before it. */
export function parseJsonArray<T>(stdout: string): T[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export const parseResults = (stdout: string) => parseJsonArray<SkillResult>(stdout);

/**
 * Skills installed in a scope. Read from disk (see `scanInstalled`): same
 * result as `skills list --json`, without its ~30 s of npx and probing.
 */
export async function listInstalled(scope: Scope, cwd?: string): Promise<InstalledSkill[]> {
  return scanInstalled(scope, cwd);
}

export async function runCommand(
  command: InstallCommand,
  opts: { cwd?: string; verbose?: boolean; onStderr?: (text: string) => void } = {},
): Promise<CommandOutcome> {
  const run = await runNpx(command.args, opts);
  if (command.kind === 'add') {
    return { command, exitCode: run.exitCode, results: parseResults(run.stdout), stderr: run.stderr };
  }
  // `skills remove` has no JSON output: check what is still installed afterwards.
  let still = new Set<string>();
  try {
    still = new Set((await listInstalled(command.scope, opts.cwd)).map((s) => s.name.toLowerCase()));
  } catch {
    // Could not verify: trust the exit code below.
  }
  const results: SkillResult[] = command.skills.map((name) =>
    run.exitCode === 0 && !still.has(name.toLowerCase())
      ? { name, status: 'removed' }
      : { name, status: 'failed', error: still.has(name.toLowerCase()) ? 'still installed' : `exit ${run.exitCode}` },
  );
  return { command, exitCode: run.exitCode, results, stderr: run.stderr };
}

/**
 * Runs the commands one after the other: they all write the same lock file
 * (`skills-lock.json` or `~/.agents/.skill-lock.json`).
 */
export async function runAll(
  commands: InstallCommand[],
  opts: {
    cwd?: string;
    verbose?: boolean;
    onStart?: (c: InstallCommand, i: number) => void;
    /** Live stderr of the running command, e.g. to follow its progress. */
    onOutput?: (text: string, i: number) => void;
    onDone?: (o: CommandOutcome, i: number) => void;
  } = {},
): Promise<CommandOutcome[]> {
  const outcomes: CommandOutcome[] = [];
  for (const [i, command] of commands.entries()) {
    opts.onStart?.(command, i);
    const outcome = await runCommand(command, { ...opts, onStderr: (text) => opts.onOutput?.(text, i) });
    outcomes.push(outcome);
    opts.onDone?.(outcome, i);
  }
  return outcomes;
}

/** A command failed if it exited non-zero or reported a skill not installed/removed as asked. */
export function isSuccess(o: CommandOutcome): boolean {
  const expected = o.command.kind === 'remove' ? 'removed' : 'installed';
  return o.exitCode === 0 && o.results.length > 0 && o.results.every((r) => r.status === expected);
}

export type Phase = 'queued' | 'fetching' | 'installing' | 'auditing' | 'done' | 'failed';

/**
 * Where a `skills add` run stands, from the markers it prints on stderr when
 * not attached to a terminal: the skills are selected once the repository is
 * fetched, then comes the installation summary, then the security audits.
 * Phases only move forward.
 */
export function phaseOf(stderr: string, current: Phase): Phase {
  const text = stderr.replace(/\u001b\[[0-9;]*m/g, '');
  const order: Phase[] = ['queued', 'fetching', 'installing', 'auditing'];
  let next: Phase = 'fetching';
  if (/Selected \d+ skill|Found \d+ skill/i.test(text)) next = 'installing';
  if (/Installation Summary|Security Risk Assessment/i.test(text)) next = 'auditing';
  if (current === 'done' || current === 'failed') return current;
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}
