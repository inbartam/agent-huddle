/**
 * F2 Identity, rendered: one naming rule (nickname or session title → first prompt → last prompt → first subagent's
 * task → "<project> session" → "Session HH:MM") in the widget card, the main window's tree and the session head; the
 * main agent's own row and panel say "Lead agent". Agent text renders as text.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentKey, selectSessionIdentity, selectTree, type AgentNode, type HuddleState } from '@huddle/shared';
import { AgentDetail } from './components/AgentDetail.js';
import { TeamTree } from './components/TeamTree.js';
import { agent, T0, XSS } from './testing/fixture.js';
import { settled } from './testing/arming.js';
import { timelineRows } from './view/timeline.js';
import { buildRows } from './view/tree.js';
import { WidgetBody } from './views/WidgetView.js';

const noop = () => undefined;
const ok = () => Promise.resolve({ ok: true as const });
const NOW = T0 + 5 * 60_000;

function root(sessionId: string, partial: Partial<AgentNode> = {}): AgentNode {
  return agent({
    key: agentKey(sessionId),
    sessionId,
    name: 'main',
    kind: 'main',
    role: 'main',
    status: 'working',
    lastEventAt: T0 + 60_000,
    ...partial,
  });
}

function stateOf(...nodes: AgentNode[]): HuddleState {
  return {
    agents: Object.fromEntries(nodes.map((n) => [n.key, n])),
    rootKeys: nodes.map((n) => n.key),
    inbox: [],
    rateLimits: null,
  };
}

function widget(state: HuddleState): string {
  return renderToStaticMarkup(
    settled(
      <WidgetBody
        state={state}
        error={null}
        renames={new Map()}
        opened={new Set()}
        onToggle={noop}
        onOpenMain={noop}
        onCommand={ok}
        now={NOW}
        onHide={noop}
        onShowHidden={noop}
        onCollapse={noop}
      />,
    ),
  );
}

/** The text of every `.scard-<part>` in the markup, in order. */
function texts(html: string, part: string): string[] {
  const re = new RegExp(`class="scard-${part}"[^>]*>([^<]*)<`, 'g');
  return [...html.matchAll(re)].map((m) => m[1] ?? '');
}

describe('session identity in the widget', () => {
  it('two unnamed sessions in different folders get different titles, not "main"', () => {
    const state = stateOf(
      root('s-api', { sessionCwd: 'C:\\work\\billing-api', model: 'claude-opus-5-5' }),
      root('s-web', { sessionCwd: '/home/me/storefront/', model: 'claude-sonnet-5-5[1m]' }),
    );
    const html = widget(state);
    const names = texts(html, 'name');
    expect(names).toEqual(expect.arrayContaining(['billing-api session', 'storefront session']));
    expect(names).not.toContain('main');
    expect(texts(html, 'chip scard-model')).toEqual(expect.arrayContaining(['Opus 5.5', 'Sonnet 5.5 · 1M']));
    // The full project path is the name's tooltip.
    expect(html).toContain('title="C:\\work\\billing-api');
  });

  it('two sessions in the same folder are named by what the user asked them', () => {
    const state = stateOf(
      root('s-1', { sessionCwd: 'C:\\work\\api', lastPrompt: 'add paging to the orders list' }),
      root('s-2', { sessionCwd: 'C:\\work\\api', lastPrompt: 'fix the flaky auth test' }),
    );
    const html = widget(state);
    expect(texts(html, 'name')).toEqual(
      expect.arrayContaining(['add paging to the orders list', 'fix the flaky auth test']),
    );
    // The prompt is the name, so it is not repeated as a topic line.
    expect(texts(html, 'line scard-topic')).toEqual([]);
  });

  it('same folder and no topic: the start time tells them apart', () => {
    const state = stateOf(
      root('s-1', { sessionCwd: 'C:\\work\\api', startedAt: T0 }),
      root('s-2', { sessionCwd: 'C:\\work\\api', startedAt: T0 + 3 * 60_000 }),
    );
    const marks = texts(widget(state), 'disambig');
    expect(marks).toHaveLength(2);
    expect(new Set(marks).size).toBe(2);
  });

  it('a prompt with markup renders literally', () => {
    const state = stateOf(root('s-1', { sessionCwd: 'C:\\work\\api', lastPrompt: `look at this ${XSS}` }));
    const html = widget(state);
    expect(html).not.toContain('<img');
    expect(html).toContain('look at this &lt;img src=x onerror=alert(1)&gt;');
  });

  it('a worktree run is titled by its repository and tagged', () => {
    const wt = 'C:\\Users\\me\\AppData\\Local\\agent-huddle\\worktrees\\run-7';
    const state = stateOf(
      root('s-run', {
        origin: 'managed',
        sessionCwd: wt,
        run: {
          runId: 'run-7',
          templateId: null,
          permissionMode: 'default',
          mainAgent: null,
          agentNames: [],
          worktree: { path: wt, branch: 'huddle/run-7', state: 'active', repoRoot: 'C:\\work\\shop' },
        },
      }),
    );
    const html = widget(state);
    expect(texts(html, 'name')).toEqual(['shop session']);
    expect(texts(html, 'chip scard-worktree')).toEqual(['worktree']);
  });
});

describe('session identity in the main window', () => {
  const state = stateOf(
    root('s-1', { sessionCwd: 'C:\\work\\api', lastPrompt: 'add paging' }),
    root('s-2', { sessionCwd: 'C:\\work\\web', lastPrompt: XSS }),
  );

  it('tree roots carry the same title and topic as the cards', () => {
    const rows = buildRows(selectTree(state), { toggled: new Set() });
    const html = renderToStaticMarkup(
      <TeamTree
        rows={rows}
        renames={new Map()}
        selectedKey={null}
        onActivate={noop}
        onToggle={noop}
        mode="main"
        label="Team"
        identity={(key) => selectSessionIdentity(state, key, NOW)}
      />,
    );
    expect(html).toContain('<span class="tree-name">add paging</span>');
    expect(html).toContain('<span class="tree-name">&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(html).toContain('<span class="tree-meta">api</span>');
    expect(html).not.toContain('<img');
  });

  it('the agent panel calls the main agent "Lead agent", with its model, and shows a topic that moved on', () => {
    const first = state.agents['s-1'];
    if (!first) throw new Error('no node');
    const node = { ...first, firstPrompt: 'add paging', lastPrompt: 'now the tests', model: 'claude-opus-5-5' };
    const moved = { ...state, agents: { ...state.agents, [node.key]: node } };
    const html = renderToStaticMarkup(
      <AgentDetail
        state={moved}
        agent={node}
        renames={new Map()}
        onRename={ok}
        onSelect={noop}
        section="now"
        onSection={noop}
        timeline={{ rows: timelineRows([], node.key), loading: false }}
        filter="all"
        onFilter={noop}
        now={NOW}
      />,
    );
    expect(html).toContain('<h2 class="agent-name agent-lead">Lead agent</h2>');
    expect(html).not.toContain('>main<');
    expect(html).toContain('class="topic-line" title="now the tests">now the tests</p>');
    // Advanced (no provider): the raw model id.
    expect(html).toContain('<span class="code">claude-opus-5-5</span>');
  });
});
