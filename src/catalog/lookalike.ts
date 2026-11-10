import type { Risk } from '../risks.js';
import type { Skill } from '../types.js';

/**
 * A skill whose name, or whose owner's name, is one character away from a far more
 * installed one: the usual shape of a copy that hopes to be taken for the original.
 * It is a hint to compare the two, not a verdict: honest forks and plurals match too.
 */

/** The original must be installed at least this much, and this many times more than the look-alike. */
const MIN_INSTALLS = 1_000;
const RATIO = 20;
/** Shorter names are one character away from too many others (`figma` and `sigma`, `email` and `emails`). */
const MIN_LENGTH = 8;

/** Separators dropped, and the digits used in place of letters put back. */
const fold = (s: string): string => s.toLowerCase().replace(/[-_.\s]/g, '').replace(/0/g, 'o').replace(/1/g, 'l');

/** One substitution, insertion or deletion apart. */
function oneApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.length === long.length ? short.slice(i + 1) === long.slice(i + 1) : short.slice(i) === long.slice(i + 1);
}

/** Different names that read alike. */
export function near(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return false;
  return fold(x) === fold(y) || (Math.min(x.length, y.length) >= MIN_LENGTH && oneApart(x, y));
}

const owner = (source: string): string => source.split('/')[0]!.toLowerCase();

type Named = Pick<Skill, 'id' | 'source' | 'name' | 'installs'>;

/** The most installed skill this one could be taken for, if any. */
export function lookalike(skill: Named, skills: Named[]): Named | undefined {
  const floor = Math.max(MIN_INSTALLS, (skill.installs ?? 0) * RATIO);
  const source = skill.source.toLowerCase();
  const name = skill.name.toLowerCase();
  let best: Named | undefined;
  for (const other of skills) {
    if ((other.installs ?? 0) < floor || (best && (best.installs ?? 0) >= (other.installs ?? 0))) continue;
    if (other.source.toLowerCase() === source) continue;
    const sameName = other.name.toLowerCase() === name;
    // Another repository's skill with a close name, or the same skill name under a close owner name.
    if (sameName ? near(owner(other.source), owner(source)) : near(other.name, name)) best = other;
  }
  return best;
}

/** The look-alike as a finding of the audit. */
export function lookalikeRisk(skill: Named, skills: Named[]): Risk | undefined {
  const original = lookalike(skill, skills);
  if (!original) return undefined;
  return {
    rule: 'lookalike', level: 'medium', label: 'name close to a far more installed skill', line: 0, count: 1, file: 'catalog',
    excerpt: `${original.id} (${original.installs} installs)`,
  };
}
