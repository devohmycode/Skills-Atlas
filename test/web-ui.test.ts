import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/en.js';
import { PAGE_HTML } from '../src/web/page.js';

/** Run the actual inline browser script with only the DOM surfaces these checks use. */
function browser(preview: unknown = { markdown: '<img src=x onerror=bad()>', risks: [] }, plan?: (body: any) => unknown) {
  let respond: (path: string, init: any) => Promise<any> = () => new Promise(() => {});
  const elements = new Map<string, any>();
  const rows = new Map<string, any>();
  function element(id: string): any {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', scrollTop: 0, events: new Map(),
      addEventListener(event: string, fn: unknown) { this.events.set(event, fn); },
      insertAdjacentHTML: vi.fn(), focus: vi.fn(), showModal: vi.fn(), close: vi.fn(),
      querySelector(selector: string) { return selector.startsWith('[data-id=') ? rows.get(selector.slice(10, -2)) : null; },
    });
    return elements.get(id);
  }
  const open = vi.fn();
  const context: any = {
    location: { hash: '#test' },
    document: { activeElement: null, getElementById: element, addEventListener: vi.fn(), querySelector: () => element('list') },
    window: { open }, fetch: (path: string, init: any) => path.startsWith('/api/preview')
      ? Promise.resolve({ ok: true, json: async () => preview }) : path === '/api/plan' && plan
        ? Promise.resolve({ ok: true, json: async () => plan(JSON.parse(init.body)) }) : respond(path, init),
    TextDecoder, Intl, URLSearchParams, CSS: { escape: (s: string) => s }, setTimeout: plan ? setTimeout : () => 0, clearTimeout,
  };
  const script = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
  new Script(script.replace(/\}\)\(\);\s*$/, `
    globalThis.ui = { view, opts, apply, body, renderRows, renderThemes, rowHtml, groupsHtml, toggle, githubUrl, installedMatches, previewSkill,
      init: function (state, messages) { M = messages; setState(state); } };
  })();`)).runInNewContext(context);
  context.ui.init({
    installed: [], agents: [{ id: 'codex', name: 'Codex', detected: true }], cwd: '.',
    themes: [{ id: 'installed', label: 'Already installed' }, { id: 'recommended', label: 'Recommended' }, { id: 'code', label: 'Code' }],
  }, en.web);
  context.ui.opts.agents.add('codex');
  const skill = { id: 'owner/repo@skill', source: 'owner/repo', name: 'skill', description: 'Description', themes: ['code'] };
  context.ui.view.items = [skill];
  context.ui.view.total = 2;
  context.ui.view.counts = { recommended: 1 };
  const pin = { checked: false };
  const row = { dataset: { id: skill.id }, classList: { toggle: vi.fn() }, querySelector: () => pin, closest: (selector: string): unknown => selector === '.row' ? row : null, tagName: 'DIV' };
  rows.set(skill.id, row);
  return { ui: context.ui, element, skill, row, pin, open,
    respond(fn: typeof respond) { respond = fn; } };
}

describe('web interface', () => {
  it('uses normalized relevance and explicit sorts for installed skills too', () => {
    const { ui, skill } = browser();
    const found = [
      { ...skill, id: 'o/r@popular', name: 'popular', description: 'Café résumé', installs: 900 },
      { ...skill, id: 'o/r@café', name: 'café', installs: 1 },
      { ...skill, id: 'o/r@label', name: 'label', labels: ['café', 'résumé'], installs: 10 },
    ];
    ui.init({ installed: found, themes: [], agents: [], cwd: '.' }, {});
    ui.view.q = 'CAFE';
    expect(ui.installedMatches().map((s: any) => s.name)).toEqual(['café', 'popular', 'label']);
    ui.view.q = 'cafe resume';
    expect(ui.installedMatches().map((s: any) => s.name)).toEqual(['popular', 'label']);
    ui.view.q = 'cafe'; ui.view.sort = 'installs';
    expect(ui.installedMatches()[0].name).toBe('popular');
  });
  it('shows partial catalog and incomplete pack diagnostics as text, and accepts legacy state', () => {
    const { ui, element } = browser();
    expect(element('catalog-health').hidden).toBe(true);
    ui.init({ installed: [], agents: [], cwd: '.',
      sources: { smithery: { status: 'error', count: 0, error: '<script>bad</script>' } },
      themes: [{ id: 'pack:test', label: 'Test', pack: { available: 1, total: 2, missing: ['a/b@<script>bad</script>'] } }],
    }, { catalogPartial: 'Partial: {sources}', packAvailability: '{available}/{total} available.', packMissing: 'Absent: {ids}' });
    expect(element('catalog-health').textContent).toBe('Partial: smithery');
    expect(element('catalog-health').hidden).toBe(false);
    ui.view.theme = 'pack:test';
    ui.renderRows(false);
    expect(element('pack-health').textContent).toContain('1/2 available.');
    expect(element('pack-health').textContent).toContain('a/b@<script>bad</script>');
    expect(element('pack-health').innerHTML).toBe('');
  });
  it('opens an escaped details dialog without changing selection and restores focus on close', async () => {
    const { ui, element, skill } = browser();
    ui.renderRows(false);
    const trigger = { focus: vi.fn() };
    await ui.previewSkill(skill, trigger);
    expect(element('details').showModal).toHaveBeenCalledOnce();
    expect(element('details-body').innerHTML).toContain('&lt;img src=x onerror=bad()&gt;');
    expect(element('details-body').innerHTML).not.toContain('<img');
    expect(ui.body().install).toEqual([]);
    element('details').onclose();
    expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it('opens details with p while Enter on its button does not toggle the row', async () => {
    const { ui, element, row } = browser();
    ui.renderRows(false);
    const keydown = element('rows').events.get('keydown');
    keydown({ target: row, key: 'p', preventDefault: vi.fn() });
    expect(element('details').showModal).toHaveBeenCalledOnce();
    keydown({ target: { ...row, tagName: 'BUTTON', closest: (s: string) => s === 'button' ? {} : s === '.row' ? row : null }, key: 'Enter', preventDefault: vi.fn() });
    expect(ui.body().install).toEqual([]);
  });

  it('displays audit failures and only sends explicitly checked per-skill overrides', async () => {
    const { ui, element, skill } = browser(undefined, (body) => ({ commands: [], collisions: [{ message: '<replacement>' }],
      blocked: body.auditOverrides.includes('owner/repo@skill') ? [] : ['owner/repo@skill'],
      audit: { enabled: true, results: [{ id: 'owner/repo@skill', risks: [{ level: 'high', rule: 'hidden', label: 'hidden', line: 1, excerpt: '<danger>' }] }] } }));
    ui.opts.agents.add('claude-code');
    ui.toggle(skill);
    await vi.waitFor(() => expect(element('audit').innerHTML).toContain('data-override="owner/repo@skill"'));
    expect(element('audit').innerHTML).toContain('&lt;danger&gt;');
    expect(element('audit').innerHTML).toContain('&lt;replacement&gt;');
    expect(element('apply').disabled).toBe(true);
    expect(ui.body().auditOverrides).toEqual([]);
    element('panel').events.get('change')({ target: { dataset: { override: skill.id }, checked: true } });
    await vi.waitFor(() => expect(element('apply').disabled).toBe(false));
    expect(ui.body().auditOverrides).toEqual(['owner/repo@skill']);
    ui.toggle(skill);
    ui.toggle(skill);
    expect(ui.body().auditOverrides).toEqual([]);
  });

  it('shows unreadable previews as errors without a passed message', async () => {
    const { ui, element, skill } = browser({ risks: [], error: '<offline>' });
    await ui.previewSkill(skill);
    expect(element('details-body').innerHTML).toContain('&lt;offline&gt;');
    expect(element('details-body').innerHTML).not.toContain('<offline>');
  });

  it('embeds the shared repository grouping without bundler helpers', () => {
    // esbuild's keepNames adds __name() calls, which the page does not define.
    expect(PAGE_HTML).toContain('function groupByRepository');
    expect(PAGE_HTML).not.toContain('__name(');
  });

  it('escapes curated reasons and keeps Recommended ahead of regular themes', () => {
    const { ui, skill, element } = browser();
    const picked = { ...skill, recommendation: { reason: '<script>bad</script>', order: 0 } };
    expect(ui.rowHtml(picked)).toContain('class="tag recommended"');
    const html = ui.groupsHtml([picked, { ...picked, id: 'other/repo@x', source: 'other/repo', recommendation: { reason: 'first', order: -1 } }]);
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    // One group per repository, in the curated order.
    expect(html.indexOf('data-repo="other/repo"')).toBeLessThan(html.indexOf('data-repo="owner/repo"'));
    ui.renderThemes();
    expect(element('themes').innerHTML.indexOf('data-theme="recommended"')).toBeLessThan(element('themes').innerHTML.indexOf('data-theme="code"'));
  });

  it('patches a toggle in place and appends only the next page', () => {
    const { ui, element, skill, pin } = browser();
    ui.renderRows(false);
    const initial = element('rows').innerHTML;
    ui.toggle(skill);
    expect(pin.checked).toBe(true);
    expect(element('rows').innerHTML).toBe(initial);
    const next = { ...skill, id: 'owner/repo@second', name: 'second' };
    ui.view.items.push(next);
    ui.renderRows(true, [next]);
    expect(element('rows').insertAdjacentHTML).toHaveBeenCalledOnce();
    expect(element('rows').insertAdjacentHTML.mock.calls[0][1]).toContain('second');
    expect(element('rows').insertAdjacentHTML.mock.calls[0][1]).not.toContain('data-id="owner/repo@skill"');
  });

  it('opens a safe GitHub URL with g on a row and leaves text entry alone', () => {
    const { ui, element, row, open } = browser();
    ui.renderRows(false);
    const keydown = element('rows').events.get('keydown');
    const preventDefault = vi.fn();
    keydown({ target: row, key: 'g', preventDefault });
    expect(open).toHaveBeenCalledWith('https://github.com/owner/repo', '_blank', 'noopener,noreferrer');
    keydown({ target: { ...row, tagName: 'INPUT' }, key: 'g', preventDefault });
    expect(open).toHaveBeenCalledOnce();
    preventDefault.mockClear();
    keydown({ target: { ...row, closest: () => row, tagName: 'A' }, key: 'Enter', preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(ui.githubUrl({ source: '../repo' })).toBe('');
    expect(ui.githubUrl({ source: 'owner/..' })).toBe('');
    expect(ui.githubUrl({ source: 'https://evil.test/owner/repo' })).toBe('');
  });
});

/** Exercise the real API/NDJSON path, without touching live installations. */
function operationBrowser(installed: any[] = []) {
  const b = browser();
  const state = {
    installed, agents: [{ id: 'codex', name: 'Codex', detected: true }], cwd: '.',
    themes: [{ id: 'code', label: 'Code' }],
  };
  b.ui.init(state, en.web);
  const requests: any[] = [];
  let refreshError = false;
  let events: any[] = [];
  let disconnect = false;
  b.respond(async (path, init) => {
    if (path === '/api/state') {
      if (refreshError) throw new Error('state unavailable');
      return { ok: true, json: async () => state };
    }
    if (path.startsWith('/api/skills?')) return {
      ok: true, json: async () => ({ items: [], total: 0, all: 0, counts: {} }),
    };
    if (path === '/api/apply') {
      requests.push(JSON.parse(init.body));
      let sent = false;
      return { ok: true, body: { getReader: () => ({ read: async () => {
        if (sent) {
          if (disconnect) throw new Error('connection lost');
          return { done: true };
        }
        sent = true;
        return { done: false, value: new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n') };
      } }) } };
    }
    throw new Error('unexpected API request: ' + path);
  });
  return {
    ...b, state, requests,
    response(next: any[], lost = false) { events = next; disconnect = lost; },
    failRefresh(fail: boolean) { refreshError = fail; },
    async retry() {
      return b.element('panel').events.get('click')({ target: { closest: () => ({ dataset: { act: 'apply' } }) } });
    },
  };
}

describe('retrying web operations', () => {
  it.each(['failed result', 'disconnect'])('retains missing agent destinations after %s and requests a verified retry', async mode => {
    const b = operationBrowser();
    b.state.agents.push({ id: 'claude-code', name: 'Claude Code', detected: true });
    b.ui.opts.agents.add('claude-code');
    b.ui.toggle(b.skill);
    b.state.installed = [{ ...b.skill, scopes: ['project', 'global'], agentsByScope: { project: ['codex'], global: ['claude-code'] } }];
    b.response([
      { type: 'start', i: 0, kind: 'add', source: 'owner/repo', skills: ['skill'] },
      ...(mode === 'failed result' ? [
        { type: 'done', i: 0, ok: false, results: [{ name: 'skill', status: 'failed', error: 'Claude Code link failed' }] },
        { type: 'end', ok: false },
      ] : []),
    ], mode === 'disconnect');
    await b.ui.apply();
    expect(b.ui.body().install).toEqual(['owner/repo@skill']);
    expect(b.element('panel-foot').innerHTML).toContain(en.web.retryRemaining);
    await b.retry();
    expect(b.requests[1]).toMatchObject({ install: ['owner/repo@skill'], retry: true });
    b.state.installed[0].agentsByScope.project.push('claude-code');
    await b.retry();
    expect(b.requests).toHaveLength(2);
    expect(b.ui.body().install).toEqual([]);
  });

  it('reports outstanding operations even when the command reported success', async () => {
    const b = operationBrowser();
    b.ui.toggle(b.skill);
    b.response([
      { type: 'start', i: 0, kind: 'add', source: 'owner/repo', skills: ['skill'] },
      { type: 'done', i: 0, ok: true, results: [{ name: 'skill', status: 'installed' }] },
      { type: 'end', ok: true },
    ]);
    await b.ui.apply();
    expect(b.ui.body().install).toEqual(['owner/repo@skill']);
    expect(b.element('progress-body').innerHTML).toContain(en.web.summaryFailed);
  });

  it('clears a completed selection and leaves close as a dismissal', async () => {
    const b = operationBrowser();
    b.ui.toggle(b.skill);
    b.state.installed = [{ ...b.skill, scopes: ['project'], agentsByScope: { project: ['codex'] } }];
    b.response([{ type: 'end', ok: true }]);
    await b.ui.apply();
    expect(b.ui.body().install).toEqual([]);
    expect(b.element('panel-foot').hidden).toBe(true);
    expect(b.element('progress-body').innerHTML).toContain(en.web.summaryOk);
    b.element('close').onclick();
    expect(b.requests).toHaveLength(1);
  });

  it('keeps only the failed skill in a partial repository and shows its escaped error', async () => {
    const b = operationBrowser();
    const other = { ...b.skill, id: 'owner/repo@other', name: 'other' };
    b.ui.toggle(b.skill); b.ui.toggle(other);
    b.state.installed = [{ ...b.skill, scopes: ['project'], agentsByScope: { project: ['codex'] } }];
    b.response([
      { type: 'start', i: 0, kind: 'add', source: 'owner/repo', skills: ['skill', 'other'] },
      { type: 'done', i: 0, ok: false, results: [
        { name: 'skill', status: 'installed' }, { name: 'other', status: 'failed', error: '<denied>' },
      ] },
      { type: 'end', ok: false },
    ]);
    await b.ui.apply();
    expect(b.ui.body().install).toEqual(['owner/repo@other']);
    expect(b.element('progress-body').innerHTML).toContain('other: &lt;denied&gt;');
    expect(b.element('progress-body').innerHTML).not.toContain('<denied>');
    expect(b.element('panel-foot').innerHTML).toContain(en.web.retryRemaining);
    expect(b.requests).toHaveLength(1);
    await b.retry();
    expect(b.requests.map(r => r.install)).toEqual([['owner/repo@skill', 'owner/repo@other'], ['owner/repo@other']]);
  });

  it('retains a failed removal and retries only skills still installed', async () => {
    const a = { id: 'owner/repo@a', source: 'owner/repo', name: 'a', scopes: ['project'] };
    const bSkill = { ...a, id: 'owner/repo@b', name: 'b' };
    const b = operationBrowser([a, bSkill]);
    b.ui.toggle(a); b.ui.toggle(bSkill);
    b.state.installed = [bSkill];
    b.response([
      { type: 'start', i: 0, kind: 'remove', skills: ['a', 'b'] },
      { type: 'done', i: 0, ok: false, results: [{ name: 'a', status: 'removed' }, { name: 'b', status: 'failed', error: 'still installed' }] },
      { type: 'end', ok: false },
    ]);
    await b.ui.apply();
    expect(b.ui.body().remove).toEqual(['owner/repo@b']);
    await b.retry();
    expect(b.requests.map(r => r.remove)).toEqual([['owner/repo@a', 'owner/repo@b'], ['owner/repo@b']]);
  });

  it.each(['disconnect', 'missing end'])('reconciles actual progress after %s', async mode => {
    const b = operationBrowser();
    const other = { ...b.skill, id: 'owner/repo@other', name: 'other' };
    b.ui.toggle(b.skill); b.ui.toggle(other);
    b.state.installed = [{ ...b.skill, scopes: ['project'], agentsByScope: { project: ['codex'] } }];
    b.response([{ type: 'start', i: 0, kind: 'add', source: 'owner/repo', skills: ['skill', 'other'] }], mode === 'disconnect');
    await b.ui.apply();
    expect(b.ui.body().install).toEqual(['owner/repo@other']);
    expect(b.element('progress-body').innerHTML).toContain(en.web.summaryFailed);
    await b.retry();
    expect(b.requests[1].install).toEqual(['owner/repo@other']);
  });

  it('preserves intent on failed refresh and blocks retry until actual state is known', async () => {
    const b = operationBrowser();
    b.ui.toggle(b.skill);
    b.response([
      { type: 'start', i: 0, kind: 'add', source: 'owner/repo', skills: ['skill'] },
      { type: 'done', i: 0, ok: true, results: [{ name: 'skill', status: 'installed' }] },
      { type: 'end', ok: true },
    ]);
    b.failRefresh(true);
    await b.ui.apply();
    expect(b.ui.body().install).toEqual(['owner/repo@skill']);
    expect(b.element('progress-body').innerHTML).toContain('state unavailable');
    await b.retry();
    expect(b.requests).toHaveLength(1);
    expect(b.ui.body().install).toEqual(['owner/repo@skill']);
    b.state.installed = [{ ...b.skill, scopes: ['project'], agentsByScope: { project: ['codex'] } }];
    b.failRefresh(false);
    await b.retry();
    expect(b.requests).toHaveLength(1);
    expect(b.ui.body().install).toEqual([]);
  });

  it('keeps an install outstanding when it only exists in another scope', async () => {
    const b = operationBrowser();
    b.ui.toggle(b.skill);
    b.state.installed = [{ ...b.skill, scopes: ['global'], agentsByScope: { global: ['codex'] } }];
    b.response([{ type: 'end', ok: false }]);
    await b.ui.apply();
    expect(b.ui.body().install).toEqual(['owner/repo@skill']);
  });
});
