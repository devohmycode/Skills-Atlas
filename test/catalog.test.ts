import { describe, expect, it, vi } from 'vitest';
import { assemble } from '../src/catalog/build.js';
import { classify } from '../src/catalog/classify.js';
import { compareSkills, dedupe } from '../src/catalog/dedupe.js';
import { enrichDescriptions, findSkillDir, guessPaths } from '../src/catalog/enrich.js';
import { INSTALLED_THEME, mergeInstalled } from '../src/catalog/installed.js';
import {
  cleanDescription,
  fixMojibake,
  frontmatterDescription,
  parseGitHubUrl,
  skillDir,
} from '../src/catalog/normalize.js';
import { groupByTheme, querySkills, resolveTheme, sortSkills } from '../src/catalog/query.js';
import { markOfficial, parseOfficialSitemap } from '../src/catalog/sources/official.js';
import { langFlag, LANGUAGES, LOCALES, normalizeLang, systemLang } from '../src/i18n/index.js';
import { allThemes } from '../src/catalog/taxonomy.js';
import { mapEntry as mapClaudePlugins } from '../src/catalog/sources/claude-plugins-dev.js';
import { mapSearchSkill, parseSkillsSitemap } from '../src/catalog/sources/skills-sh.js';
import { mapEntry as mapSmithery } from '../src/catalog/sources/smithery.js';
import claudePluginsPage from './fixtures/claude-plugins-dev.json' with { type: 'json' };
import smitheryPage from './fixtures/smithery.json' with { type: 'json' };

describe('normalize', () => {
  it('parses GitHub tree URLs', () => {
    expect(parseGitHubUrl('https://github.com/anthropics/claude-code/tree/main/plugins/fd/skills/fd')).toEqual({
      source: 'anthropics/claude-code',
      path: 'plugins/fd/skills/fd',
    });
    expect(parseGitHubUrl('https://github.com/o/r.git')).toEqual({ source: 'o/r', path: undefined });
    expect(parseGitHubUrl('https://gitlab.com/o/r')).toBeUndefined();
    // A link to the SKILL.md gives its directory; at the repository root, '' (not the file name).
    expect(parseGitHubUrl('https://github.com/o/r/blob/main/skills/x/SKILL.md')?.path).toBe('skills/x');
    expect(parseGitHubUrl('https://github.com/o/r/blob/main/SKILL.md')?.path).toBe('');
    expect(parseGitHubUrl('https://github.com/o/r/tree/main/')?.path).toBe('');
  });

  it('turns a path to a SKILL.md into its directory', () => {
    expect(skillDir('SKILL.md')).toBe('');
    expect(skillDir('skills/x/SKILL.md')).toBe('skills/x');
    expect(skillDir('skills\\x\\skill.md')).toBe('skills/x');
    expect(skillDir('/skills/x/')).toBe('skills/x');
    expect(skillDir('skills/SKILL.md-tools')).toBe('skills/SKILL.md-tools');
  });

  it('repairs double-encoded UTF-8', () => {
    const latin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
    const cp1252 = (s: string) => new TextDecoder('windows-1252').decode(Buffer.from(s, 'utf8'));
    expect(fixMojibake(latin1('飞书即时通讯'))).toBe('飞书即时通讯');
    expect(fixMojibake(cp1252('コーディング — “quotes”'))).toBe('コーディング — “quotes”');
    expect(fixMojibake('Ã©tÃ©')).toBe('été');
    expect(fixMojibake('déjà vu')).toBe('déjà vu');
  });

  it('drops YAML block indicators left as descriptions', () => {
    expect(cleanDescription('>')).toBeUndefined();
    expect(cleanDescription('|-')).toBeUndefined();
    expect(cleanDescription('  a \n  b ')).toBe('a b');
  });

  it('reads inline, quoted and block descriptions from SKILL.md', () => {
    expect(frontmatterDescription('---\nname: x\ndescription: Plain text.\n---\nbody')).toBe('Plain text.');
    expect(frontmatterDescription('---\ndescription: "Quoted: yes"\n---')).toBe('Quoted: yes');
    expect(frontmatterDescription('---\nname: x\ndescription: >\n  Folded\n  lines.\nlicense: MIT\n---')).toBe('Folded lines.');
    expect(frontmatterDescription('no frontmatter')).toBeUndefined();
  });
});

describe('sources', () => {
  it('maps claude-plugins.dev entries', () => {
    const skills = claudePluginsPage.skills.map(mapClaudePlugins);
    expect(skills[0]).toMatchObject({
      origin: 'claude-plugins.dev',
      name: 'frontend-design',
      source: 'anthropics/claude-code',
      path: 'plugins/frontend-design/skills/frontend-design',
      installs: 23292,
      stars: 52420,
    });
  });

  it('maps Smithery entries, taking the name from the git path', () => {
    const skills = smitheryPage.skills.map(mapSmithery);
    expect(skills[0]).toMatchObject({ name: 'smithery-ai-cli', source: 'smithery-ai/cli' });
    expect(skills[1]).toMatchObject({ name: 'frontend-design', labels: ['Design', 'Coding'], stars: 63077 });
  });

  it('parses skills.sh sitemaps and search results', () => {
    const xml = `<urlset><url><loc>https://www.skills.sh/vercel-labs/skills/find-skills</loc></url>
      <url><loc>https://www.skills.sh/vercel-labs</loc></url></urlset>`;
    expect(parseSkillsSitemap(xml)).toEqual([
      { origin: 'skills.sh', name: 'find-skills', source: 'vercel-labs/skills', rank: 1 },
    ]);
    expect(mapSearchSkill({ source: 'supabase/agent-skills', name: 'supabase', installs: 5 })).toEqual({
      origin: 'skills.sh',
      name: 'supabase',
      source: 'supabase/agent-skills',
      installs: 5,
    });
    expect(mapSearchSkill({ source: 'vercel.com', name: 'x' })).toBeUndefined();
  });
});

describe('dedupe', () => {
  it('merges the same skill across sources', () => {
    const [merged, ...rest] = dedupe([
      { origin: 'skills.sh', name: 'PDF', source: 'anthropics/skills', installs: 100 },
      { origin: 'claude-plugins.dev', name: 'pdf', source: 'Anthropics/skills', installs: 10, stars: 5, description: 'Handle PDFs' },
      { origin: 'smithery', name: 'pdf', source: 'anthropics/skills', labels: ['Productivity'] },
    ]);
    expect(rest).toHaveLength(0);
    expect(merged).toMatchObject({
      id: 'anthropics/skills@PDF',
      installs: 100,
      stars: 5,
      description: 'Handle PDFs',
      labels: ['Productivity'],
      origins: ['skills.sh', 'claude-plugins.dev', 'smithery'],
    });
  });
});

describe('classify desktop apps apart from mobile', () => {
  const c = (name: string, description: string) => classify({ name, description, labels: [] });

  it('puts macOS apps in desktop even when written in Swift', () => {
    expect(c('build-macos-apps', 'Build professional native macOS apps in Swift with SwiftUI and AppKit.')).toEqual(['desktop']);
    expect(c('swift-macos', 'Build macOS applications - AppKit, windows, menus, system integration')[0]).toBe('desktop');
    expect(c('asc-notarization', 'Archive, export, and notarize macOS apps using xcodebuild and asc.')[0]).toBe('desktop');
    expect(c('menubar-app', 'Create a menu bar app for the Mac')[0]).toBe('desktop');
  });

  it('covers Electron, Tauri and Windows desktop stacks', () => {
    expect(c('electron-builder', 'Package an Electron desktop application')[0]).toBe('desktop');
    expect(c('tauri-v2', 'Tauri 2 apps with a Rust core')[0]).toBe('desktop');
    expect(c('winui-app', 'WinUI 3 and WPF guidance')[0]).toBe('desktop');
  });

  it('keeps iOS apps in mobile and ignores Claude Desktop', () => {
    expect(c('swiftui-ios', 'SwiftUI views for iPhone and iPad apps on iOS')[0]).toBe('mobile');
    expect(c('mcp-setup', 'Configure MCP servers in Claude Desktop')).not.toContain('desktop');
  });
});

describe('classify', () => {
  it('uses the name, the description and source labels', () => {
    expect(classify({ name: 'react-best-practices', description: 'React and Next.js patterns', labels: [] })[0]).toBe('frontend');
    expect(classify({ name: 'supabase-postgres', description: 'Postgres performance', labels: [] })[0]).toBe('databases');
    expect(classify({ name: 'pdf', description: 'Extract text from PDF documents', labels: [] })[0]).toBe('documents');
    expect(classify({ name: 'zzz', labels: ['Security'] })).toEqual(['security']);
    expect(classify({ name: 'zzz', labels: [] })).toEqual(['other']);
  });

  it('keeps a second theme only when it scores close to the first', () => {
    const themes = classify({ name: 'docker-postgres', description: 'Run a Postgres database in Docker', labels: [] });
    expect(themes).toHaveLength(2);
    expect(themes).toEqual(expect.arrayContaining(['devops', 'databases']));
  });
});

describe('query', () => {
  const catalog = assemble({
    'skills.sh': [
      { origin: 'skills.sh', name: 'react-hooks', source: 'a/b', installs: 50, description: 'React hooks' },
      { origin: 'skills.sh', name: 'pentest', source: 'c/d', installs: 5, description: 'Security testing' },
    ],
    'claude-plugins.dev': [{ origin: 'claude-plugins.dev', name: 'unknown-thing', source: 'e/f' }],
    smithery: [],
  });

  it('sorts by popularity and hides skills without signal by default', () => {
    expect(catalog.skills[0]!.name).toBe('react-hooks');
    expect(querySkills(catalog).map((s) => s.name)).toEqual(['react-hooks', 'pentest']);
    expect(querySkills(catalog, { all: true })).toHaveLength(3);
  });

  it('filters by theme, search and installs', () => {
    expect(querySkills(catalog, { themes: ['security'] }).map((s) => s.name)).toEqual(['pentest']);
    expect(querySkills(catalog, { search: 'hooks react' }).map((s) => s.name)).toEqual(['react-hooks']);
    expect(querySkills(catalog, { minInstalls: 10 })).toHaveLength(1);
  });

  it('resolves themes by id or label, accents ignored', () => {
    expect(resolveTheme(catalog, 'securite')?.id).toBe('security');
    expect(resolveTheme(catalog, 'Security')?.id).toBe('security');
    expect(resolveTheme(catalog, 'bases de donnees')?.id).toBe('databases');
    expect(resolveTheme(catalog, 'frontend')?.id).toBe('frontend');
    expect(resolveTheme(catalog, 'nope')).toBeUndefined();
  });

  it('groups skills under every theme they belong to', () => {
    const groups = groupByTheme(catalog.themes, querySkills(catalog));
    expect(groups.map((g) => g.theme.id)).toContain('frontend');
    expect(groups.every((g) => g.skills.length > 0)).toBe(true);
  });
});

describe('ordering', () => {
  it('puts skills.sh-ranked skills first, in rank order, then by popularity', () => {
    const mk = (id: string, extra: object) => ({ id, name: id, source: 'o/r', labels: [], origins: [], themes: [], ...extra });
    const sorted = [
      mk('small-but-ranked', { rank: 2 }),
      mk('many-stars', { stars: 9000 }),
      mk('top', { rank: 1, installs: 10 }),
      mk('few-installs', { installs: 50 }),
    ].sort(compareSkills);
    expect(sorted.map((s) => s.id)).toEqual(['top', 'small-but-ranked', 'many-stars', 'few-installs']);
  });
});

describe('official skills', () => {
  it('reads official owners from the officialskills.sh sitemap, skill pages only', () => {
    const xml = [
      'https://officialskills.sh/',
      'https://officialskills.sh/collections/automation',
      'https://officialskills.sh/anthropics/skills',
      'https://officialskills.sh/anthropics/skills/pdf',
      'https://officialskills.sh/MiniMax-AI/skills/minimax-pdf',
    ].map((u) => `<url><loc>${u}</loc></url>`).join('');
    expect([...parseOfficialSitemap(xml)]).toEqual(['anthropics', 'minimax-ai']);
  });

  it('flags every skill of an official owner, case-insensitively', () => {
    const catalog = assemble(
      {
        'skills.sh': [
          { origin: 'skills.sh', name: 'pdf', source: 'Anthropics/skills', installs: 5 },
          { origin: 'skills.sh', name: 'copycat', source: 'someone/skills', installs: 50 },
        ],
        'claude-plugins.dev': [],
        smithery: [],
      },
      undefined,
      new Set(['anthropics']),
    );
    expect(catalog.stats.official).toBe(1);
    expect(querySkills(catalog, { official: true }).map((s) => s.name)).toEqual(['pdf']);
    expect(markOfficial(catalog.skills, new Set())).toBe(0);
    expect(catalog.skills.some((s) => s.official)).toBe(false);
  });
});

describe('sorting', () => {
  const mk = (name: string, extra: object) => ({ id: `o/r@${name}`, name, source: 'o/r', labels: [], origins: [], themes: [], ...extra });
  const skills = [mk('ranked-first', { rank: 1, installs: 31 }), mk('beta', { installs: 900 }), mk('alpha', { stars: 5 }), mk('gamma', {})];

  it('sorts by installs, stars breaking ties, or by name', () => {
    expect(sortSkills(skills, 'installs').map((s) => s.name)).toEqual(['beta', 'ranked-first', 'alpha', 'gamma']);
    expect(sortSkills(skills, 'name').map((s) => s.name)).toEqual(['alpha', 'beta', 'gamma', 'ranked-first']);
  });

  it('is applied by querySkills when asked', () => {
    const catalog = assemble({ 'skills.sh': [], 'claude-plugins.dev': [], smithery: [] });
    catalog.skills = skills;
    expect(querySkills(catalog, { sort: 'installs' })[0]!.name).toBe('beta');
    expect(querySkills(catalog)[0]!.name).toBe('ranked-first');
  });
});

describe('enrich', () => {
  it('locates a skill directory in a repository tree', () => {
    const paths = ['README.md', 'skills/pdf/SKILL.md', 'plugins/x/skills/pdf/SKILL.md', 'skills/docx/SKILL.md'];
    expect(findSkillDir(paths, 'pdf')).toBe('skills/pdf');
    expect(findSkillDir(paths, 'PDF')).toBe('skills/pdf');
    expect(findSkillDir(paths, 'xlsx')).toBeUndefined();
    expect(findSkillDir(['SKILL.md', 'README.md'], 'solo')).toBe('');
  });

  it('flags the skills a complete repository tree no longer holds', async () => {
    const skill = (name: string, source = 'o/r') => ({ id: `${source}@${name}`, name, source, labels: [], origins: [], themes: [] });
    const [kept, gone, unknown] = [skill('pdf'), skill('to-prd'), skill('x', 'o/truncated')];
    const trees: Record<string, object> = {
      'o/r': { tree: [{ path: 'skills/pdf/SKILL.md', type: 'blob' }] },
      'o/truncated': { tree: [{ path: 'skills/pdf/SKILL.md', type: 'blob' }], truncated: true },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      const repo = /repos\/(.+?)\/git\/trees/.exec(url)?.[1];
      return new Response(repo ? JSON.stringify(trees[repo]) : '---\nname: pdf\ndescription: PDF tools\n---\n');
    });
    try {
      const { filled, missing } = await enrichDescriptions([kept, gone, unknown], { max: 10, githubToken: 't' });
      expect(filled).toBe(1);
      expect(kept).toMatchObject({ description: 'PDF tools', path: 'skills/pdf' });
      // Gone from a complete tree; a truncated one proves nothing.
      expect([...missing]).toEqual([gone]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('guesses the usual layouts first', () => {
    expect(guessPaths('pdf')[0]).toBe('skills/pdf');
  });
});

describe('installed skills', () => {
  const mk = (source: string, name: string, themes: string[]) => ({ id: `${source}@${name}`, name, source, labels: [], origins: [], themes });
  const pdf = mk('anthropics/skills', 'pdf', ['documents']);
  const hidden = mk('a/b', 'rare', ['code']);
  const catalogSkills = [pdf, hidden, mk('c/d', 'other', ['ai'])];

  it('matches installed skills to the catalog, even hidden ones, and adds unknown ones', () => {
    const tree = mergeInstalled(catalogSkills, [pdf], [
      { name: 'PDF', source: 'Anthropics/skills', scope: 'project', agents: ['Claude Code'] },
      { name: 'rare', source: 'a/b', scope: 'project', agents: [] },
      { name: 'homemade', scope: 'project', agents: ['Codex'] },
    ]);
    expect([...tree.installed.entries()]).toEqual([
      ['anthropics/skills@pdf', { name: 'PDF', scopes: ['project'], agents: ['Claude Code'] }],
      ['a/b@rare', { name: 'rare', scopes: ['project'], agents: [] }],
      ['local@homemade', { name: 'homemade', scopes: ['project'], agents: ['Codex'] }],
    ]);
    const byId = new Map(tree.skills.map((s) => [s.id, s]));
    expect(byId.get('anthropics/skills@pdf')!.themes).toEqual([INSTALLED_THEME.id, 'documents']);
    expect(byId.get('a/b@rare')!.themes).toEqual([INSTALLED_THEME.id, 'code']);
    expect(byId.get('local@homemade')!.description).toContain('Codex');
    expect(tree.skills).toHaveLength(3);
    // The catalog itself is untouched.
    expect(pdf.themes).toEqual(['documents']);
  });

  it('merges a skill installed in both scopes into one entry, project first', () => {
    const tree = mergeInstalled(catalogSkills, [pdf], [
      { name: 'pdf', source: 'anthropics/skills', scope: 'global', agents: ['Codex'] },
      { name: 'pdf', source: 'anthropics/skills', scope: 'project', agents: ['Claude Code', 'Codex'] },
    ]);
    // Agents of both scopes together, each once.
    expect([...tree.installed.values()]).toEqual([{ name: 'pdf', scopes: ['project', 'global'], agents: ['Codex', 'Claude Code'] }]);
    expect(tree.skills).toHaveLength(1);
  });
});

describe('i18n', () => {
  it('normalizes language codes', () => {
    expect(normalizeLang('FR')).toBe('fr');
    expect(normalizeLang('fr_FR.UTF-8')).toBe('fr');
    expect(normalizeLang('en-US')).toBe('en');
    expect(normalizeLang('de')).toBe('de');
    expect(normalizeLang('it-IT')).toBe('it');
    expect(normalizeLang('zh-CN')).toBe('zh');
    expect(normalizeLang('zh')).toBe('zh');
    expect(normalizeLang('nl')).toBeUndefined();
    expect(normalizeLang(undefined)).toBeUndefined();
  });

  it('picks the system language from LC_ALL, LC_MESSAGES, LANG, then the OS locale', () => {
    expect(systemLang({ LANG: 'zh_CN.UTF-8' }, 'en-US')).toBe('zh');
    expect(systemLang({ LC_ALL: 'ja_JP.UTF-8', LANG: 'fr_FR.UTF-8' }, 'en-US')).toBe('ja');
    expect(systemLang({ LC_MESSAGES: 'ko_KR.UTF-8' }, 'en-US')).toBe('ko');
    // Windows sets no LANG: the OS locale decides.
    expect(systemLang({}, 'fr-FR')).toBe('fr');
    expect(systemLang({ LANG: 'C.UTF-8' }, 'ja-JP')).toBe('ja');
    // A language we do not have, set explicitly, is not overridden by the OS locale.
    expect(systemLang({ LANG: 'nl_NL.UTF-8' }, 'fr-FR')).toBeUndefined();
    expect(systemLang({ LANG: 'it_IT.UTF-8' }, 'en-US')).toBe('it');
    expect(systemLang({}, 'it-IT')).toBe('it');
    expect(normalizeLang('zh-TW')).toBe('zh');
    expect(systemLang({ LANG: 'pt_BR.UTF-8' }, 'en-US')).toBe('pt');
    expect(systemLang({}, 'de-AT')).toBe('de');
    expect(systemLang({}, 'es-MX')).toBe('es');
  });

  it('has a number locale for every language', () => {
    for (const lang of Object.keys(LANGUAGES)) expect(LOCALES[lang as keyof typeof LOCALES], lang).toBeTruthy();
  });

  it('reads -l / --lang anywhere before --', () => {
    expect(langFlag(['-l', 'fr'])).toBe('fr');
    expect(langFlag(['themes', '--lang', 'en'])).toBe('en');
    expect(langFlag(['-l=fr', 'list'])).toBe('fr');
    expect(langFlag(['--lang=fr'])).toBe('fr');
    expect(langFlag(['list', '--', '-l', 'fr'])).toBeUndefined();
    expect(langFlag(['list'])).toBeUndefined();
    expect(langFlag(['-l'])).toBe('');
  });

  it('translates every theme of the taxonomy in every language', () => {
    // From the taxonomy, not from English: a new theme must be translated everywhere.
    const ids = ['recommended', ...[INSTALLED_THEME, ...allThemes()].map((th) => th.id)];
    for (const [lang, messages] of Object.entries(LANGUAGES)) {
      for (const id of ids) expect(messages.themes[id], `${lang}: ${id}`).toBeTruthy();
    }
  });
});
