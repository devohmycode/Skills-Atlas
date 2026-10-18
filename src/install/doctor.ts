import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Scope } from '../types.js';
import { frontmatterName, lockPath, skillDirectories } from './scan.js';

export interface DoctorIssue {
  scope: Scope;
  code: 'unreadable-directory' | 'broken-link' | 'missing-skill-md' | 'unreadable-skill' | 'invalid-lock' | 'unreadable-lock' | 'stale-lock-entry';
  path: string;
  name?: string;
}

const Lock = z.object({ skills: z.record(z.string(), z.object({ source: z.string().optional() })) });

/** Read-only diagnostics; ordinary absent directories and lock files are normal. */
export function diagnoseInstalled(scope: Scope, cwd = process.cwd()): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const names = new Set<string>();
  const add = (code: DoctorIssue['code'], path: string, name?: string) => issues.push({ scope, code, path, ...(name === undefined ? {} : { name }) });
  for (const dir of skillDirectories(scope, cwd).keys()) {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') add('unreadable-directory', dir);
      else {
        try { if (lstatSync(dir).isSymbolicLink()) add('broken-link', dir); } catch { /* An absent directory is normal. */ }
      }
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let linked = false;
      try {
        linked = lstatSync(path).isSymbolicLink();
        if (!statSync(path).isDirectory()) continue;
      } catch (err) {
        add(linked && (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'broken-link' : 'unreadable-directory', path);
        continue;
      }
      const markdown = join(path, 'SKILL.md');
      try {
        names.add((frontmatterName(readFileSync(markdown, 'utf8')) ?? entry).toLowerCase());
      } catch (err) {
        add((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-skill-md' : 'unreadable-skill', markdown);
      }
    }
  }
  const path = lockPath(scope, cwd);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') add('unreadable-lock', path);
    return issues;
  }
  try {
    const lock = Lock.parse(JSON.parse(text));
    for (const name of Object.keys(lock.skills).sort()) if (!names.has(name.toLowerCase())) add('stale-lock-entry', path, name);
  } catch {
    add('invalid-lock', path);
  }
  return issues;
}
