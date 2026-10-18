import pLimit from 'p-limit';
import { fetchSkillMarkdown } from './github.js';
import { scanRisks, type Risk } from './risks.js';
import type { Skill } from './types.js';

/**
 * The security audit run before an install: the risk check of each skill's
 * SKILL.md. A skill fails it with at least one high warning sign; medium and
 * info signs are reported, not blocking.
 */
export interface AuditResult {
  id: string;
  risks: Risk[];
  /** The SKILL.md could not be read: the skill is not audited, which is not a failure. */
  error?: string;
}

export const failsAudit = (r: AuditResult): boolean => r.risks.some((x) => x.level === 'high');

type Target = Pick<Skill, 'id' | 'source' | 'name' | 'path'>;

/** The skill to read for an id: the catalog's entry (it knows the path), else one built from the id. */
export function auditTarget(id: string, known?: Map<string, Target>): Target {
  const found = known?.get(id.toLowerCase());
  if (found) return found;
  const at = id.lastIndexOf('@');
  return { id, source: id.slice(0, at), name: id.slice(at + 1) };
}

/** Audits the skills, a few at a time; results keep the order of `targets`. */
export async function auditSkills(targets: Target[], read: (s: Target) => Promise<string> = fetchSkillMarkdown): Promise<AuditResult[]> {
  const limit = pLimit(8);
  return Promise.all(
    targets.map((t) =>
      limit(async () => {
        try {
          return { id: t.id, risks: scanRisks(await read(t)) };
        } catch (err) {
          return { id: t.id, risks: [], error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
  );
}

/** Whether to audit: on unless the config or the command line turns it off. */
export const auditEnabled = (config: { audit?: boolean }, flag?: boolean): boolean => flag !== false && config.audit !== false;
