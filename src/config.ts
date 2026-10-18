import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InstallMethod, Scope } from './types.js';

/** Choices remembered between runs, used to pre-fill the prompts. */
export interface UserConfig {
  agents?: string[];
  scope?: Scope;
  method?: InstallMethod;
  /** Interface language set with `skills-atlas lang <code>`. */
  lang?: string;
  /** `false` (set with `skills-atlas audit off`): install without the security audit. */
  audit?: boolean;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'skills-atlas', 'config.json');
}

export function readConfig(path = configPath()): UserConfig {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as UserConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: UserConfig, path = configPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // Remembering choices is a convenience; never fail an install over it.
  }
}
