/**
 * A first look at what a SKILL.md asks an agent to do, before installing it.
 * Pattern matching on the text: it points at lines worth reading, it does not
 * prove a skill safe. Each rule has an English label for machine output; the
 * interface translates it by id.
 */

import { onPath, prerequisites } from './prereqs.js';

export type RiskLevel = 'high' | 'medium' | 'info';
export type RiskRule = 'pipeShell' | 'credentials' | 'destructive' | 'hidden' | 'sudo' | 'secrets' | 'sendsData' | 'runsCode' | 'missingBin' | 'requires' | 'unaudited';

export interface Risk {
  rule: RiskRule;
  level: RiskLevel;
  label: string;
  /** First line (1-based) where the rule matched, and how many lines matched. */
  line: number;
  count: number;
  excerpt: string;
  /** The skill file it was found in, relative to the skill folder; absent for SKILL.md. */
  file?: string;
}

const RULES: { rule: RiskRule; level: RiskLevel; label: string; re: RegExp }[] = [
  {
    rule: 'pipeShell', level: 'high', label: 'downloads and runs code',
    re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?((ba|z)?sh\b|iex\b|(python3?|node)\s+-(\s|$))|base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh\b/i,
  },
  {
    rule: 'credentials', level: 'high', label: 'touches credential files',
    // A verb that reads or sends, just before the file: skills that refuse credential files name them too.
    re: /\b(cat|type|read|open|copy|cp|scp|rsync|upload|send|print|base64|tar|zip|curl|wget|less|head)\b[^\n]{0,40}?((^|[\s"'`(=/~])\.(ssh|aws|gnupg|kube|docker|netrc|npmrc|pypirc)\b|\bid_(rsa|ed25519)\b|\bcredentials\.json\b|\bKeychain\b)/i,
  },
  { rule: 'destructive', level: 'high', label: 'deletes broadly', re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\*|\.\s*$)(\s|$)|\bRemove-Item\b[^\n]*-Recurse[^\n]*(\\|\/|~)\s*$/i },
  {
    rule: 'hidden', level: 'high', label: 'asks the agent to hide things or ignore its instructions',
    re: /(?<!["'“«`])\b(ignore|disregard)\s+(all\s+)?(previous|prior|earlier|above|system)\s+(instructions|prompts?|rules)\b|\b(do not|don't|never)\s+(tell|inform|mention to|show)\s+the\s+user\b|\bwithout\s+(asking|telling|notifying)\s+the\s+user\b/i,
  },
  { rule: 'sudo', level: 'medium', label: 'runs commands as administrator', re: /(^|[\s`$(])sudo\s+\S|\brunas\s+\/user\b|-Verb\s+RunAs\b/i },
  { rule: 'secrets', level: 'medium', label: 'reads secrets from the environment', re: /\$\{?[A-Z0-9_]*(TOKEN|SECRET|API_?KEY|PASSWORD|PASSWD)\b|\bprocess\.env\.[A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD)\b|\b(printenv|env)\s*\|/ },
  {
    rule: 'sendsData', level: 'medium', label: 'sends data to a server',
    re: /\bcurl\b[^\n]*(\s-d\s|\s--data|\s-X\s*(POST|PUT)|\s-F\s|\s--upload-file)|\bwget\b[^\n]*--post-(data|file)|\bmethod:\s*['"](POST|PUT)['"]|\brequests\.(post|put)\(/i,
  },
  {
    rule: 'runsCode', level: 'info', label: 'installs or runs packages or scripts',
    re: /\b(npx|bunx|uvx|pipx)\s+(-y\s+)?[@\w]|\b(pip3?|npm|pnpm|yarn|brew|apt(-get)?|cargo|go)\s+(install|add|i)\b|\b(scripts?|bin)\/[\w.-]+\.(sh|py|js|ts|ps1|rb)\b/i,
  },
];

const ORDER: Record<RiskLevel, number> = { high: 0, medium: 1, info: 2 };

/** The rules a SKILL.md matches, most serious first, each with its first line. */
export function scanRisks(markdown: string, has: (bin: string) => boolean = onPath): Risk[] {
  const found = new Map<RiskRule, Risk>();
  markdown.split('\n').forEach((text, i) => {
    for (const r of RULES) {
      if (!r.re.test(text)) continue;
      const seen = found.get(r.rule);
      if (seen) seen.count++;
      else found.set(r.rule, { rule: r.rule, level: r.level, label: r.label, line: i + 1, count: 1, excerpt: text.trim().slice(0, 160) });
    }
  });
  // What the frontmatter says the skill needs: a missing program makes its first real task fail.
  const pre = prerequisites(markdown);
  const missing = pre.bins?.names.filter((b) => !has(b)) ?? [];
  if (missing.length) found.set('missingBin', { rule: 'missingBin', level: 'medium', label: 'needs a program not found on this machine', line: pre.bins!.line, count: 1, excerpt: `missing: ${missing.join(', ')} (needs ${pre.bins!.names.join(', ')})` });
  if (pre.compatibility) found.set('requires', { rule: 'requires', level: 'info', label: 'states its requirements', line: pre.compatibility.line, count: 1, excerpt: pre.compatibility.text });
  return sortRisks([...found.values()]);
}

/** Most serious first, then SKILL.md before other files, then by line. */
export const sortRisks = (risks: Risk[]): Risk[] =>
  risks.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (a.file ?? '').localeCompare(b.file ?? '') || a.line - b.line);

/** One line for an agent: `Risk check: …` or that nothing matched. */
export function riskReport(risks: Risk[]): string {
  if (!risks.length) return 'skills-atlas risk check: no warning sign found (a pattern check, not a guarantee).';
  const lines = risks.map((r) => `- ${r.level}: ${r.label} (${riskWhere(r)}${r.count > 1 ? `, ${r.count} lines` : ''}): ${r.excerpt}`);
  return ['skills-atlas risk check (a pattern check, not a guarantee):', ...lines].join('\n');
}

/** Where a finding is, for people: `scripts/setup.sh:12`, or `SKILL.md:3`. */
export const riskWhere = (r: Pick<Risk, 'file' | 'line'>): string => `${r.file ?? 'SKILL.md'}${r.line ? `:${r.line}` : ''}`;
