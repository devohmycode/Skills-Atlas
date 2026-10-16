import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeInstalled } from '../src/catalog/installed.js';
import { setLang } from '../src/i18n/index.js';
import type { Skill, Theme } from '../src/types.js';
import { App, type WizardResult } from '../src/ui/App.js';
import { ListSelect } from '../src/ui/ListSelect.js';
import { parseMouse } from '../src/ui/mouse.js';
import { fit, padEnd, width } from '../src/ui/width.js';
import stringWidth from 'string-width';
import { TreeSelect } from '../src/ui/TreeSelect.js';

afterEach(cleanup);

const themes: Theme[] = [
  { id: 'frontend', label: 'Frontend & web' },
  { id: 'security', label: 'Sécurité' },
  { id: 'other', label: 'Autres' },
];
const skill = (id: string, themeIds: string[], description?: string): Skill => {
  const [source, name] = id.split('@') as [string, string];
  return { id, name, source, description, installs: 10, labels: [], origins: ['skills.sh'], themes: themeIds };
};
const skills = [
  skill('a/b@react-hooks', ['frontend'], 'React hooks'),
  skill('a/b@tailwind', ['frontend'], 'Tailwind CSS'),
  skill('c/d@pentest', ['security'], 'Penetration testing'),
];

const KEY = { up: '\u001B[A', down: '\u001B[B', right: '\u001B[C', left: '\u001B[D', enter: '\r', escape: '\u001B' };
const tick = () => new Promise((r) => setTimeout(r, 40));
async function press(stdin: { write: (s: string) => void }, ...keys: string[]) {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

describe('TreeSelect', () => {
  it('shows collapsed themes with counts, expands and selects', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    expect(lastFrame()).toMatch(/▸ ○ Frontend & web\s+2/);
    expect(lastFrame()).not.toContain('Other');
    await press(stdin, KEY.right, KEY.down, ' ');
    expect(lastFrame()).toContain('◉ react-hooks');
    expect(lastFrame()).toContain('1 selected');
    expect(lastFrame()).toContain('React hooks');
    await press(stdin, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith(['a/b@react-hooks']);
  });

  it('applies keys typed faster than the screen redraws', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    for (const k of [KEY.right, KEY.down, KEY.down, ' ', KEY.enter]) stdin.write(k);
    await tick();
    expect(lastFrame()).toContain('1 selected');
    expect(onSubmit).toHaveBeenCalledWith(['a/b@tailwind']);
  });

  it('keeps expansion and collapse current throughout a burst of keys', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    for (const key of [KEY.right, KEY.down, KEY.down, KEY.left, KEY.down, KEY.right, KEY.down, ' ', KEY.enter]) stdin.write(key);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(['c/d@pentest']);
  });

  it('does not rescan collapsed skills when moving or hovering over themes', async () => {
    let idReads = 0;
    const manySkills = Array.from({ length: 400 }, (_, i) => {
      const id = `a/b@skill-${i}`;
      return Object.defineProperty(skill(id, [i % 2 ? 'frontend' : 'security']), 'id', {
        get: () => { idReads++; return id; },
      });
    });
    const { stdin, unmount } = render(<TreeSelect themes={themes} skills={manySkills} onSubmit={() => {}} onCancel={() => {}} />);
    await tick();
    idReads = 0;
    await press(stdin, KEY.down, mouse(35, 20, LIST_Y));
    expect(idReads).toBe(0);
    unmount();
  });

  it('opens the focused skill repository with g, including during rapid navigation', async () => {
    const onOpenGitHub = vi.fn();
    const { stdin, lastFrame } = render(
      <TreeSelect themes={themes} skills={skills} onSubmit={() => {}} onCancel={() => {}} onOpenGitHub={onOpenGitHub} />,
    );
    await tick();
    for (const key of [KEY.right, KEY.down, KEY.down, 'g']) stdin.write(key);
    await tick();
    expect(onOpenGitHub).toHaveBeenCalledExactlyOnceWith(skills[1]);
    expect(lastFrame()).toContain('g GitHub');
  });

  it.each(['s', 'o'])('uses the updated view when %s and navigation arrive before redraw', async (action) => {
    const ranked = [
      { ...skill('z/repo@zeta', ['frontend']), installs: 1000 },
      { ...skill('a/repo@alpha', ['frontend']), installs: 10, official: true },
    ];
    const onSubmit = vi.fn();
    const onOpenGitHub = vi.fn();
    const { stdin } = render(
      <TreeSelect themes={themes} skills={ranked} onSubmit={onSubmit} onCancel={() => {}} onOpenGitHub={onOpenGitHub} />,
    );
    await tick();
    for (const key of [action, KEY.right, KEY.down, ' ', 'g', KEY.enter]) stdin.write(key);
    await tick();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(['a/repo@alpha']);
    expect(onOpenGitHub).toHaveBeenCalledExactlyOnceWith(ranked[1]);
  });

  it('enters search before handling the next key in the same input burst', async () => {
    const onOpenGitHub = vi.fn();
    const { stdin, lastFrame } = render(
      <TreeSelect themes={themes} skills={skills} onSubmit={() => {}} onCancel={() => {}} onOpenGitHub={onOpenGitHub} />,
    );
    await tick();
    for (const key of [KEY.right, KEY.down, '/', 'g']) stdin.write(key);
    await tick();
    expect(onOpenGitHub).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('search: g');
  });

  it('uses the completed search for navigation and actions before redraw', async () => {
    const ranked = [
      { ...skill('z/repo@zeta', ['frontend']), installs: 1000 },
      { ...skill('a/repo@alpha', ['frontend']), installs: 10 },
    ];
    const onSubmit = vi.fn();
    const onOpenGitHub = vi.fn();
    const { stdin } = render(
      <TreeSelect themes={themes} skills={ranked} onSubmit={onSubmit} onCancel={() => {}} onOpenGitHub={onOpenGitHub} />,
    );
    await tick();
    for (const key of ['/', 'a', 'l', 'p', 'h', 'a', KEY.enter, KEY.down, ' ', 'g', KEY.enter]) stdin.write(key);
    await tick();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(['a/repo@alpha']);
    expect(onOpenGitHub).toHaveBeenCalledExactlyOnceWith(ranked[1]);
  });

  it('does not open GitHub from headers, local skills, or while entering a search', async () => {
    const onOpenGitHub = vi.fn();
    const localSkills = [skill('local@notes', ['frontend']), skill('https://evil.test@unsafe', ['frontend']), skill('a/b@github', ['frontend'])];
    const { stdin } = render(
      <TreeSelect themes={themes} skills={localSkills} onSubmit={() => {}} onCancel={() => {}} onOpenGitHub={onOpenGitHub} />,
    );
    await press(stdin, 'g', KEY.right, KEY.down, 'g', KEY.down, 'g', KEY.down, '/', 'g', KEY.enter);
    expect(onOpenGitHub).not.toHaveBeenCalled();
  });

  it('groups recommended skills under their repository, which opens and ticks as a whole', async () => {
    const recommendation = { repository: 'https://github.com/a/b', reason: 'A practical starting point for reliable React patterns.', order: 1 };
    const picked = skills.filter((s) => s.source === 'a/b').map((s) => ({ ...s, themes: ['recommended', ...s.themes], recommendation }));
    const other = { ...skills[2]!, themes: ['recommended', ...skills[2]!.themes], recommendation: { ...recommendation, reason: 'First.', order: 0 } };
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <TreeSelect themes={[{ id: 'recommended', label: 'Recommended' }, ...themes]} skills={[...picked, other]} onSubmit={onSubmit} onCancel={() => {}} />,
    );
    await tick();
    expect(lastFrame()).toContain('★ Recommended');
    await press(stdin, KEY.right);
    const frame = lastFrame()!;
    // Curated order, not popularity: the repository picked first comes first.
    expect(frame.indexOf(`★ ${other.source}`)).toBeLessThan(frame.indexOf('★ a/b'));
    expect(frame).not.toContain('react-hooks');
    await press(stdin, KEY.down, KEY.down);
    expect(lastFrame()).toContain('A practical starting point for reliable React patterns.');
    await press(stdin, KEY.right);
    expect(lastFrame()).toContain('react-hooks');
    await press(stdin, KEY.down, KEY.left);
    expect(lastFrame()).not.toContain('react-hooks');
    await press(stdin, ' ', KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith(picked.map((s) => s.id));
  });

  it('selects a whole theme with space on its header', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={onSubmit} onCancel={() => {}} />);
    await press(stdin, ' ');
    expect(lastFrame()).toContain('◉ Frontend & web');
    await press(stdin, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith(['a/b@react-hooks', 'a/b@tailwind']);
  });

  it('filters with / and expands matching groups', async () => {
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={() => {}} onCancel={() => {}} />);
    await press(stdin, '/', 'p', 'e', 'n', KEY.enter);
    const frame = lastFrame()!;
    expect(frame).toContain('search: pen');
    expect(frame).toContain('pentest');
    expect(frame).not.toContain('Frontend');
  });

  it('collapses back to the theme with the left arrow', async () => {
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={() => {}} onCancel={() => {}} />);
    await press(stdin, KEY.right, KEY.down, KEY.down, KEY.left);
    expect(lastFrame()).toContain('▸ ○ Frontend & web');
    expect(lastFrame()).not.toContain('tailwind');
  });
});

/** SGR mouse report: left press, release, or wheel at a 1-based column and line. */
const mouse = (button: number, x: number, y: number, final = 'M') => `\u001B[<${button};${x};${y}${final}`;
const click = (x: number, y: number) => mouse(0, x, y);
/** Click on the first occurrence of `text` in a frame, as a mouse user would. */
const clickOn = (frame: string | undefined, text: string) => {
  const lines = (frame ?? '').split('\n');
  const y = lines.findIndex((l) => l.includes(text));
  if (y < 0) throw new Error(`"${text}" is not on screen`);
  return click(lines[y]!.indexOf(text) + 2, y + 1);
};
/** Standalone tree: status, search, blank line, then the list from screen line 4. */
const LIST_Y = 4;

describe('mouse', () => {
  it('parses SGR reports', () => {
    expect(parseMouse(mouse(0, 12, 7))).toEqual({ kind: 'click', x: 12, y: 7 });
    expect(parseMouse(mouse(0, 12, 7, 'm'))?.kind).toBe('release');
    expect(parseMouse('[<64;1;1M')?.kind).toBe('wheelUp');
    expect(parseMouse(mouse(65 | 4, 1, 1))?.kind).toBe('wheelDown');
    expect(parseMouse('\u001B[A')).toBeUndefined();
  });

  it('marks the row under the mouse', async () => {
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={() => {}} onCancel={() => {}} />);
    expect(parseMouse(mouse(35, 3, 4))).toEqual({ kind: 'move', x: 3, y: 4 });
    await press(stdin, mouse(35, 20, LIST_Y + 1));
    expect(lastFrame()).toMatch(/› ▸ ○ Security/);
    await press(stdin, mouse(35, 20, 1));
    expect(lastFrame()).not.toContain('›');
  });

  it('opens a theme and ticks a skill on click', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={onSubmit} onCancel={() => {}} />);
    await press(stdin, click(20, LIST_Y));
    expect(lastFrame()).toContain('▾ ○ Frontend & web');
    await press(stdin, click(20, LIST_Y + 2));
    expect(lastFrame()).toContain('◉ tailwind');
    expect(lastFrame()).toContain('1 selected');
    await press(stdin, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith(['a/b@tailwind']);
  });

  it('ticks a whole theme on its checkbox and scrolls with the wheel', async () => {
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={() => {}} onCancel={() => {}} />);
    await press(stdin, click(5, LIST_Y));
    expect(lastFrame()).toContain('◉ Frontend & web');
    expect(lastFrame()).toContain('▸');
    await press(stdin, mouse(65, 1, 1));
    expect(lastFrame()).toMatch(/❯ .*Security/);
  });

  it('continues from the tree with the continue button, only once something is ticked', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={onSubmit} onCancel={onCancel} />);
    await press(stdin, clickOn(lastFrame(), '↵ next'));
    expect(onSubmit).not.toHaveBeenCalled();
    await press(stdin, click(5, LIST_Y));
    expect(lastFrame()).toContain('[↵ next]');
    await press(stdin, clickOn(lastFrame(), '↵ next'));
    expect(onSubmit).toHaveBeenCalledWith(['a/b@react-hooks', 'a/b@tailwind']);
    await press(stdin, clickOn(lastFrame(), 'q quit'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('sorts and filters official skills from the buttons', async () => {
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={skills} onSubmit={() => {}} onCancel={() => {}} />);
    await press(stdin, clickOn(lastFrame(), 's sort'));
    expect(lastFrame()).toContain('sorted by name');
    await press(stdin, clickOn(lastFrame(), 'o official'));
    expect(lastFrame()).toContain('official only');
  });

  it('goes through the wizard with the mouse only', async () => {
    let result: WizardResult | null | undefined;
    const { lastFrame, stdin } = render(
      <App
        themes={themes}
        skills={skills}
        preset={{}}
        defaults={{ agents: ['claude-code'], scope: 'project', method: 'symlink' }}
        skillsVersion="1.7.0"
        onDone={(r) => (result = r)}
      />,
    );
    await tick();
    await press(stdin, clickOn(lastFrame(), 'Security'));
    await press(stdin, clickOn(lastFrame(), '○ pentest'));
    await press(stdin, clickOn(lastFrame(), '↵ next'));
    await press(stdin, clickOn(lastFrame(), 'Global'));
    await press(stdin, clickOn(lastFrame(), '↵ next'));
    expect(lastFrame()).toContain('pentest');
    await press(stdin, clickOn(lastFrame(), '↵ apply'));
    expect(result?.ids).toEqual(['c/d@pentest']);
    expect(result?.options.scope).toBe('global');
  });

  it('chooses an item of a single list on click, without typing into the filter', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <ListSelect
        title="Where?"
        items={[
          { value: 'project', label: 'Project' },
          { value: 'global', label: 'Global' },
        ]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Title, blank line, then the items.
    await press(stdin, click(4, 4));
    expect(onSubmit).toHaveBeenCalledWith(['global']);
  });
});

describe('TreeSelect sort and official filter', () => {
  const ranked = [
    { ...skill('x/y@less-installed', ['frontend']), installs: 5 },
    { ...skill('anthropics/skills@most-installed', ['frontend']), installs: 500, official: true },
  ];

  it('sorts by installs by default and cycles the order with s', async () => {
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={ranked} onSubmit={() => {}} onCancel={() => {}} />);
    await press(stdin, KEY.right);
    expect(lastFrame()).toContain('sorted by installs');
    expect(lastFrame()!.indexOf('most-installed')).toBeLessThan(lastFrame()!.indexOf('less-installed'));
    await press(stdin, 's');
    expect(lastFrame()).toContain('sorted by name');
    expect(lastFrame()!.indexOf('less-installed')).toBeLessThan(lastFrame()!.indexOf('most-installed'));
  });

  it('marks official skills and shows only them with o', async () => {
    const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={ranked} onSubmit={() => {}} onCancel={() => {}} />);
    await press(stdin, KEY.right);
    expect(lastFrame()).toMatch(/◆ ○ most-installed/);
    await press(stdin, 'o');
    expect(lastFrame()).toContain('◆ official only');
    expect(lastFrame()).toMatch(/Frontend & web\s+1/);
    expect(lastFrame()).not.toContain('less-installed');
  });
});

describe('App wizard', () => {
  const defaults = { agents: ['claude-code'], scope: 'project' as const, method: 'symlink' as const };

  it('asks only for options not given as flags, then confirms', async () => {
    let result: WizardResult | null = null;
    const { lastFrame, stdin } = render(
      <App themes={themes} skills={skills} preset={{ agents: ['claude-code'] }} defaults={defaults} skillsVersion="1.7.0" onDone={(r) => (result = r)} />,
    );
    // The tree comes first; the scope is asked only because there is something to install.
    await tick();
    await press(stdin, ' ', KEY.enter);
    expect(lastFrame()).toContain('Where should the new skills be installed?');
    await press(stdin, KEY.down, KEY.enter);
    // A single agent means a single directory: no method question.
    expect(lastFrame()).toContain('npx -y skills@1.7.0 add a/b -s react-hooks tailwind -a claude-code -g -y --json');
    await press(stdin, KEY.enter);
    expect(result).toEqual({
      ids: ['a/b@react-hooks', 'a/b@tailwind'],
      remove: [],
      options: { agents: ['claude-code'], scope: 'global', method: 'symlink', skillsVersion: '1.7.0' },
    });
  });

  it('asks for agents and method when several directories are involved', async () => {
    let result: WizardResult | null = null;
    const { lastFrame, stdin } = render(
      <App
        themes={themes}
        skills={skills}
        preset={{ scope: 'project' }}
        defaults={{ ...defaults, agents: [] }}
        skillsVersion="1.7.0"
        initialIds={['c/d@pentest']}
        onDone={(r) => (result = r)}
      />,
    );
    expect(lastFrame()).toContain('Which agents');
    // Type to filter the agent list, then tick Claude Code and Windsurf.
    await press(stdin, 'c', 'l', 'a', 'u', 'd', 'e', ' ');
    for (let i = 0; i < 6; i++) await press(stdin, '\u007F');
    await press(stdin, 'w', 'i', 'n', 'd', 's', 'u', 'r', 'f', ' ', KEY.enter);
    expect(lastFrame()).toContain('How should skills be installed');
    // Each step starts fresh: the agent filter must not leak into this list.
    expect(lastFrame()).toContain('Symlink');
    await press(stdin, KEY.down, KEY.enter, KEY.enter);
    expect(result).toMatchObject({ ids: ['c/d@pentest'], options: { agents: ['claude-code', 'windsurf'], method: 'copy' } });
  });

  it('returns null when leaving the tree', async () => {
    const onDone = vi.fn();
    const { stdin } = render(
      <App themes={themes} skills={skills} preset={{ scope: 'project' }} defaults={defaults} skillsVersion="1.7.0" onDone={onDone} />,
    );
    await tick();
    await press(stdin, 'q');
    expect(onDone).toHaveBeenCalledWith(null);
  });
});

describe('installed skills in the wizard', () => {
  const defaults = { agents: ['claude-code'], scope: 'project' as const, method: 'symlink' as const };
  const loadInstalled = vi.fn(async (scopes: ('project' | 'global')[]) =>
    mergeInstalled(
      skills,
      skills,
      scopes.map((scope) => ({ name: 'pentest', source: 'c/d', scope, agents: ['Claude Code'] })),
    ),
  );
  const app = (onDone: (r: WizardResult | null) => void, preset: { scope?: 'project' | 'global' } = {}) => (
    <App themes={themes} skills={skills} preset={preset} defaults={defaults} skillsVersion="1.7.0" loadInstalled={loadInstalled} onDone={onDone} />
  );

  it('pre-ticks installed skills and turns unticking into a removal', async () => {
    let result: WizardResult | null = null;
    const { lastFrame, stdin } = render(app((r) => (result = r)));
    await tick();
    await tick();
    // Both scopes are read when no scope is given.
    expect(loadInstalled).toHaveBeenLastCalledWith(['project', 'global']);
    expect(lastFrame()).toMatch(/◉ Already installed\s+1 ✓\s+1/);
    expect(lastFrame()).toContain('scope: project + global');
    await press(stdin, KEY.right, KEY.down);
    expect(lastFrame()).toContain('● project + global');
    // Untick pentest: it goes from both scopes.
    await press(stdin, ' ');
    expect(lastFrame()).toContain('will be uninstalled');
    expect(lastFrame()).toContain('−1');
    await press(stdin, KEY.enter);
    // Only a removal: no scope, agent or method question.
    expect(lastFrame()).toContain('Uninstall 1 skill (from every agent)');
    expect(lastFrame()).toContain('pentest (project + global)');
    expect(lastFrame()).toContain('npx -y skills@1.7.0 remove -s pentest -y');
    expect(lastFrame()).toContain('npx -y skills@1.7.0 remove -s pentest -y -g');
    await press(stdin, KEY.enter);
    expect(result).toMatchObject({ ids: [], remove: [{ name: 'pentest', scopes: ['project', 'global'] }] });
  });

  it('reads only the scope given as a flag', async () => {
    const { lastFrame } = render(app(() => {}, { scope: 'global' }));
    await tick();
    await tick();
    expect(loadInstalled).toHaveBeenLastCalledWith(['global']);
    expect(lastFrame()).toContain('scope: global');
  });

  it('does not validate when nothing differs', async () => {
    const onDone = vi.fn();
    const { stdin } = render(app(onDone));
    await tick();
    await tick();
    await press(stdin, KEY.enter);
    expect(onDone).not.toHaveBeenCalled();
    await press(stdin, 'q');
    expect(onDone).toHaveBeenCalledWith(null);
  });
});

describe('wide characters', () => {
  it('pads and cuts by terminal columns, never splitting a wide character', () => {
    expect(width('技能')).toBe(4);
    expect(padEnd('技能', 6)).toBe('技能  ');
    expect(fit('前端与后端开发', 7)).toBe('前端与…');
    expect(width(fit('前端与后端开发', 8))).toBe(8);
    expect(fit('abc', 5)).toBe('abc  ');
  });

  it('keeps the tree columns aligned in Chinese, with Chinese skill names', async () => {
    setLang('zh');
    try {
      const cjk = [
        { ...skill('a/b@前端组件', ['frontend']), installs: 900 },
        { ...skill('a/b@react-hooks', ['frontend']), installs: 50 },
      ];
      const { lastFrame, stdin } = render(<TreeSelect themes={themes} skills={cjk} onSubmit={() => {}} onCancel={() => {}} />);
      await press(stdin, KEY.right);
      const frame = lastFrame()!;
      expect(frame).toContain('前端与 Web');
      const rows = frame.split('\n').filter((l) => l.includes('a/b'));
      expect(rows).toHaveLength(2);
      // The popularity column is right-aligned: both rows end at the same column, whatever the name's script.
      expect(stringWidth(rows[0]!.trimEnd())).toBe(stringWidth(rows[1]!.trimEnd()));
    } finally {
      setLang('en');
    }
  });
});

describe('French interface', () => {
  it('renders the wizard in French when asked', async () => {
    setLang('fr');
    try {
      const { lastFrame, stdin } = render(
        <App themes={themes} skills={skills} preset={{}} defaults={{ agents: ['claude-code'], scope: 'project', method: 'symlink' }} skillsVersion="1.7.0" onDone={() => {}} />,
      );
      await tick();
      expect(lastFrame()).toContain('Sélection');
      expect(lastFrame()).toContain('Sécurité');
      expect(lastFrame()).toContain('0 coché');
      await press(stdin, ' ', KEY.enter);
      expect(lastFrame()).toContain('Où installer les nouveaux skills ?');
      expect(lastFrame()).toContain('Portée');
    } finally {
      setLang('en');
    }
  });
});
