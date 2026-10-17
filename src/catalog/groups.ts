/**
 * Recommended skills by repository (lower-case `owner/repo`), in the curated
 * order; each group keeps the list's order. Self-contained, as the web page
 * embeds its source: the terminal and the page group the same way.
 */
export function groupByRepository<T extends { source: string; recommendation?: { order: number } }>(skills: T[]): { source: string; skills: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const s of skills) {
    const key = s.source.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  // No named inner function: esbuild's keepNames would wrap it in a helper the page does not have.
  return Array.from(groups, ([source, list]) => ({ source, skills: list })).sort(
    (a, b) => (a.skills[0]!.recommendation?.order ?? 0) - (b.skills[0]!.recommendation?.order ?? 0),
  );
}
