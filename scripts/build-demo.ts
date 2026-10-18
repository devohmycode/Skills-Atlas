/**
 * Builds docs/demo/index.html: the real web interface, served by GitHub Pages
 * without a server. A small script answers the page's API calls from embedded
 * data (the recommended skills and the most installed ones); nothing installs.
 *
 *   npm run demo
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS } from '../src/agents.js';
import { loadCatalog } from '../src/catalog/load.js';
import { haystack, querySkills, sortSkills } from '../src/catalog/query.js';
import { withRecommendations } from '../src/catalog/recommended.js';
import { withTrending } from '../src/catalog/trending.js';
import { getLang, setLang, t, themeLabel } from '../src/i18n/index.js';
import { PAGE_HTML } from '../src/web/page.js';

/** Enough to browse every theme; the full catalog would weigh tens of megabytes. */
const TOP = 3000;
const out = join('docs', 'demo', 'index.html');

setLang('en');
const catalog = withTrending(withRecommendations(await loadCatalog()));
const all = querySkills(catalog, {});
const top = sortSkills(all, 'installs').slice(0, TOP);
const skills = [...new Map([...all.filter((s) => s.recommendation || s.themes.includes('trending')), ...top].map((s) => [s.id, s])).values()].map((s) => ({
  id: s.id, name: s.name, source: s.source, description: s.description, installs: s.installs, stars: s.stars, growth: s.growth,
  rank: s.rank, official: s.official, recommendation: s.recommendation, themes: s.themes, text: haystack(s),
}));
const state = {
  lang: getLang(),
  locale: 'en',
  messages: {
    ...t().web,
    tagline: `Live demo with ${skills.length.toLocaleString('en')} of ${all.length.toLocaleString('en')} skills — nothing installs here. Run npx skills-atlas ui for the real thing.`,
    // Apply always answers with the demo notice: say so, rather than "some changes failed".
    summaryFailed: 'Demo only',
    summaryFailedHint: 'Nothing is installed from this page. Copy the commands, or run npx skills-atlas ui on your machine.',
  },
  cwd: '~/your-project',
  skillsVersion: '1.7.0',
  themes: catalog.themes.map((th) => ({ id: th.id, label: themeLabel(th) })),
  agents: AGENTS.map((a) => ({ id: a.id, name: a.displayName, detected: ['claude-code', 'codex', 'cursor'].includes(a.id) })),
  defaults: { agents: ['claude-code'], scope: 'project', method: 'symlink' },
  installed: [],
};

// Answers the page's /api calls like the local server does, on the embedded skills.
const shim = `<script>
(function () {
  var DEMO = ${JSON.stringify({ state, skills }).replace(/</g, '\\u003c')};
  var json = function (body, status) { return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } })); };
  var byName = DEMO.skills.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  window.fetch = function (input, init) {
    var url = new URL(String(input), location.href);
    if (url.pathname.endsWith('/api/state')) return json(DEMO.state);
    if (url.pathname.endsWith('/api/skills')) {
      var p = url.searchParams, terms = (p.get('q') || '').toLowerCase().split(/\\s+/).filter(Boolean);
      var official = p.get('official') === '1', theme = p.get('theme');
      var matching = (p.get('sort') === 'name' ? byName : DEMO.skills).filter(function (s) {
        return (!official || s.official) && terms.every(function (t) { return s.text.indexOf(t) >= 0; });
      });
      var counts = {};
      matching.forEach(function (s) { s.themes.forEach(function (th) { counts[th] = (counts[th] || 0) + 1; }); });
      var inTheme = theme ? matching.filter(function (s) { return s.themes.indexOf(theme) >= 0; }) : matching;
      if (theme === 'trending') inTheme = inTheme.slice().sort(function (a, b) { return (b.growth || 0) - (a.growth || 0); });
      var offset = Number(p.get('offset')) || 0, limit = Math.min(500, Number(p.get('limit')) || 100);
      return json({ total: inTheme.length, all: matching.length, counts: counts, items: inTheme.slice(offset, offset + limit) });
    }
    if (url.pathname.endsWith('/api/plan')) {
      var body = JSON.parse(init.body), bySource = {};
      body.install.forEach(function (id) { var at = id.lastIndexOf('@'); (bySource[id.slice(0, at)] = bySource[id.slice(0, at)] || []).push(id.slice(at + 1)); });
      return json({ commands: Object.keys(bySource).map(function (src) {
        return ['npx -y skills@' + DEMO.state.skillsVersion, 'add', src, '-s'].concat(bySource[src], ['-a'], body.options.agents,
          body.options.scope === 'global' ? ['-g'] : [], body.options.method === 'copy' ? ['--copy'] : [], ['-y --json']).join(' ');
      }) });
    }
    if (url.pathname.endsWith('/api/apply')) return json({ error: 'This is a demo: run npx skills-atlas ui to install skills.' }, 400);
    return Promise.reject(new Error('not available in the demo'));
  };
})();
</script>`;

const html = PAGE_HTML.replace('<script>', `${shim}\n<script>`);
mkdirSync(join('docs', 'demo'), { recursive: true });
writeFileSync(out, html);
console.log(`${out}: ${skills.length} skills, ${(html.length / 1024 / 1024).toFixed(1)} MB`);
