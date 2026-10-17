import type { WizardResult } from './ui/App.js';

/**
 * The interactive session: show the wizard, apply what it returns, then show
 * it again with the run's summary, until the user leaves it without a change.
 * A dry run stops after printing its commands. Returns how many runs applied changes.
 */
export async function browseLoop(
  wizard: (notice: string) => Promise<WizardResult | null>,
  apply: (result: WizardResult) => Promise<string>,
  opts: { dryRun?: boolean } = {},
): Promise<number> {
  let notice = '';
  for (let runs = 0; ; runs++) {
    const result = await wizard(notice);
    if (!result) return runs;
    notice = await apply(result);
    if (opts.dryRun) return runs + 1;
  }
}
