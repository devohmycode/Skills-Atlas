import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatterDescription } from './catalog/normalize.js';
import type { InstalledSkill } from './install/run.js';

/**
 * Installed skills an agent may take for one another. An agent picks a skill from its
 * name and description alone: two skills that describe the same job compete for the same
 * requests, and which one runs is not predictable. Descriptions are compared by their
 * words, each weighed by how rare it is among the installed skills (TF-IDF, cosine):
 * it points at pairs worth reading side by side, it does not prove they conflict.
 */

/** Similarity from which two descriptions are reported, between 0 and 1. */
export const OVERLAP_THRESHOLD = 0.5;

const STOP = new Set(
  ('a an and are as at be but by can do does for from has have how i if in into is it its may must no not of on or should so than that the their them then there these this those to up use used uses using user users want wants when whenever where which who why will with without you your also any all ask asks asked about after before even only such via etc skill skills task tasks need needs ' +
    'le la les de des du un une et ou a au aux pour dans que qui en est sur par avec sans ce cette ces son sa ses plus pas ne se').split(' '),
);

/** The words of a text that say what it is about: lower case, plurals and common endings folded. */
export function words(text: string): string[] {
  return (text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z][a-z0-9+#]*/g) ?? [])
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w));
}

export interface Described {
  name: string;
  description: string;
  scope: InstalledSkill['scope'];
  source?: string;
  agents: string[];
}

export interface Overlap {
  a: Described;
  b: Described;
  /** 0 to 1, two decimals. */
  score: number;
  /** The words that weigh most in the match. */
  shared: string[];
  /** The agents that see both skills. */
  agents: string[];
}

/** Pairs of skills seen by a same agent whose descriptions are close, the closest first. */
export function findOverlaps(skills: Described[], threshold = OVERLAP_THRESHOLD): Overlap[] {
  // The name is part of what the agent reads, and says the job in two or three words.
  const bags = skills.map((s) => {
    const counts = new Map<string, number>();
    for (const w of words(`${s.name.replace(/[-_:]/g, ' ')} ${s.description}`)) counts.set(w, (counts.get(w) ?? 0) + 1);
    return counts;
  });
  const df = new Map<string, number>();
  for (const bag of bags) for (const w of bag.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log((skills.length + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const vectors = bags.map((bag) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [w, n] of bag) {
      const x = (1 + Math.log(n)) * idf(w);
      v.set(w, x);
      norm += x * x;
    }
    return { v, norm: Math.sqrt(norm) };
  });
  const out: Overlap[] = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const agents = skills[i]!.agents.filter((a) => skills[j]!.agents.includes(a));
      const [x, y] = [vectors[i]!, vectors[j]!];
      if (!agents.length || !x.norm || !y.norm) continue;
      const parts: [string, number][] = [];
      let dot = 0;
      for (const [w, value] of x.v) {
        const other = y.v.get(w);
        if (other === undefined) continue;
        dot += value * other;
        parts.push([w, value * other]);
      }
      const score = dot / (x.norm * y.norm);
      if (score < threshold) continue;
      out.push({ a: skills[i]!, b: skills[j]!, score: Math.round(score * 100) / 100, shared: parts.sort((p, q) => q[1] - p[1]).slice(0, 6).map(([w]) => w), agents });
    }
  }
  return out.sort((p, q) => q.score - p.score || p.a.name.localeCompare(q.a.name));
}

/** The installed skills with the description their SKILL.md gives; one without a readable description is left out. */
export function describeInstalled(installed: InstalledSkill[], read: (path: string) => string = (p) => readFileSync(join(p, 'SKILL.md'), 'utf8')): Described[] {
  const out: Described[] = [];
  for (const s of installed) {
    if (!s.path) continue;
    let description: string | undefined;
    try {
      description = frontmatterDescription(read(s.path));
    } catch {
      description = undefined;
    }
    if (description) out.push({ name: s.name, description, scope: s.scope, source: s.source, agents: s.agents });
  }
  return out;
}
