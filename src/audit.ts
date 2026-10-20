import pLimit from 'p-limit';
import { fetchSkillFiles, fetchSkillMarkdown, type SkillFiles } from './github.js';
import { scanRisks, sortRisks, type Risk } from './risks.js';
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

type ReadFiles = (s: Target) => Promise<SkillFiles>;
const noFiles: ReadFiles = async () => ({ files: [], skipped: [] });

/**
 * Audits the skills, a few at a time; results keep the order of `targets`. Besides the
 * SKILL.md, the other text files of the skill folder are checked: a script it runs can
 * hold what the SKILL.md does not show. With a `read` of its own (tests), no other file
 * is read unless `readFiles` is given too.
 */
export async function auditSkills(
  targets: Target[],
  read: (s: Target) => Promise<string> = fetchSkillMarkdown,
  readFiles: ReadFiles = read === fetchSkillMarkdown ? fetchSkillFiles : noFiles,
): Promise<AuditResult[]> {
  const limit = pLimit(8);
  return Promise.all(
    targets.map((t) =>
      limit(async () => {
        let risks: Risk[];
        try {
          risks = scanRisks(await read(t));
        } catch (err) {
          return { id: t.id, risks: [], error: err instanceof Error ? err.message : String(err) };
        }
        try {
          const { files, skipped } = await readFiles(t);
          for (const f of files) risks.push(...scanRisks(f.text, () => true).map((r) => ({ ...r, file: f.path })));
          if (skipped.length) risks.push(unaudited(skipped));
        } catch (err) {
          risks.push(unaudited([`other files (${err instanceof Error ? err.message : String(err)})`]));
        }
        return { id: t.id, risks: sortRisks(risks) };
      }),
    ),
  );
}

const unaudited = (paths: string[]): Risk => ({
  rule: 'unaudited', level: 'info', label: 'files not audited', line: 0, count: paths.length,
  excerpt: paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` (+${paths.length - 5})` : ''),
});

/** Whether to audit: on unless the config or the command line turns it off. */
export const auditEnabled = (config: { audit?: boolean }, flag?: boolean): boolean => flag !== false && config.audit !== false;
