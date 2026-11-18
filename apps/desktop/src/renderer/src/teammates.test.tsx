/**
 * Agent-team teammates in the UI (M6 item 3, S20), from the agent-team fixture state: the "teammate" badge and the
 * "team lead" label (words, not colour), the idle words, idle teammates stay out of Finished, the detail's team facts
 * and known limits (tokens `—` with a tooltip, never 0), disabled controls with a reason, and the counts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { selectTree, type HuddleEvent, type HuddleState } from '@huddle/shared';
import { AgentDetail } from './components/AgentDetail.js';
import { TeamTree } from './components/TeamTree.js';
import { ALPHA_IDLE, TEAM_KEYS, TEAM_NOW, teamState } from './testing/team-fixture.js';
import { counts } from './view/summary.js';
import { agentLook, lastTeammateIdle, TEAMMATE_IDLE_LOOK, TEAMMATE_WORDS } from './view/teammates.js';
import { buildRows, sessionStatus } from './view/tree.js';
import { WidgetBody } from './views/WidgetView.js';

const noop = () => undefined;
const ok = () => Promise.resolve({ ok: true as const });

function tree(state: HuddleState, mode: 'main' | 'widget' = 'main', toggled: ReadonlySet<string> = new Set()) {
  const rows = buildRows(selectTree(state), { toggled, rootsCollapsed: mode === 'widget' });
  return renderToStaticMarkup(
    <TeamTree
      rows={rows}
      renames={new Map()}
      selectedKey={null}
      onActivate={noop}
      onToggle={noop}
      mode={mode}
      label="Team"
    />,
  );
}

function detail(state: HuddleState, key: string, events: readonly HuddleEvent[] = []) {
  const a = state.agents[key];
  if (!a) throw new Error('no agent');
  return renderToStaticMarkup(
    <AgentDetail
      state={state}
      agent={a}
      renames={new Map()}
      onRename={ok}
      onSelect={noop}
      section="now"
      onSection={noop}
      timeline={{ rows: [], loading: false, events }}
      filter="all"
      onFilter={noop}
      now={TEAM_NOW}
    />,
  );
}

/** One treeitem's opening tag and contents, by the start of its accessible name. */
function row(html: string, name: string): string {
  const re = new RegExp(
    `<div[^>]*role="treeitem"[^>]*aria-label="${name}[,"][\\s\\S]*?(?=<div[^>]*role="treeitem"|<div class="tree-group"|$)`,
  );
  const m = re.exec(html);
  if (!m) throw new Error(`no row ${name}`);
  return m[0];
}

describe('team tree with teammates', () => {
  it('marks each teammate with the word "teammate" and the lead with "team lead"', () => {
    const html = tree(teamState());
    for (const name of ['alpha', 'beta']) {
      const r = row(html, name);
      expect(r).toContain('class="tree-kind"');
      expect(r).toContain(`>${TEAMMATE_WORDS.badge}<`);
      expect(r).toContain('is-teammate');
      expect(r).toContain(`aria-label="${name}, teammate, ${TEAMMATE_WORDS.idle}`);
    }
    const lead = row(html, 'main');
    expect(lead).toContain(`>${TEAMMATE_WORDS.lead}<`);
    expect(lead).toContain('title="Leads 2 teammates"');
    expect(lead).toContain('team lead, Leads 2 teammates');
  });

  it('a plain subagent gets no teammate badge, and a session without teammates no lead label', () => {
    const html = tree(teamState());
    expect(row(html, '\\(scrubbed text\\)')).not.toContain('tree-kind');
    const solo = teamState({ alpha: { kind: 'subagent' }, beta: { kind: 'subagent' } });
    expect(tree(solo)).not.toContain(TEAMMATE_WORDS.lead);
  });

  it('shows an idle teammate as "idle, waiting for the lead" with the idle glyph', () => {
    const r = row(tree(teamState()), 'alpha');
    expect(r).toContain('data-status="idle"');
    expect(r).toContain(`>${TEAMMATE_IDLE_LOOK.glyph}<`);
    expect(r).toContain(`title="${TEAMMATE_WORDS.idle}"`);
    expect(agentLook('teammate', 'working', false).label).toBe('working');
    expect(agentLook('subagent', 'idle', false).label).toBe('idle');
    // A stale session's words win: its idle is history.
    expect(agentLook('teammate', 'idle', true).label).toBe('not seen since Huddle restarted');
  });

  it('keeps idle teammates in the live tree: only the finished subagent is in Finished', () => {
    const rows = buildRows(selectTree(teamState()), { toggled: new Set() });
    const agents = rows.filter((r) => r.kind === 'agent');
    const finished = agents.filter((r) => r.finished).map((r) => r.key);
    expect(finished).toEqual([TEAM_KEYS.helper]);
    const live = agents.filter((r) => !r.finished);
    expect(live.map((r) => [r.key, r.depth])).toEqual([
      [TEAM_KEYS.lead, 0],
      [TEAM_KEYS.alpha, 1],
      [TEAM_KEYS.beta, 1],
    ]);
    const group = rows.find((r) => r.kind === 'finished-label');
    expect(group?.kind === 'finished-label' ? group.count : null).toBe(1);
  });

  it('in the widget the collapsed session reads idle with the lead label and counts its teammates', () => {
    const html = tree(teamState(), 'widget');
    const lead = row(html, 'main');
    expect(lead).toContain('team lead');
    expect(lead).toContain('+3');
    expect(lead).toContain('>idle<');
  });

  it('renders the widget body with teammates (text only, no markup from names)', () => {
    const html = renderToStaticMarkup(
      <WidgetBody
        state={teamState({ alpha: { name: '<b>alpha</b>' } })}
        error={null}
        renames={new Map()}
        opened={new Set([TEAM_KEYS.lead])}
        onToggle={noop}
        onOpenMain={noop}
      />,
    );
    expect(html).not.toContain('<b>alpha');
  });
});

describe('teammate detail', () => {
  it('says which team, when it last went idle, and the idle words', () => {
    const html = detail(teamState(), TEAM_KEYS.alpha, [ALPHA_IDLE]);
    expect(html).toContain('class="team-chip"');
    expect(html).toContain('Teammate in <span class="code">session-00000000</span>');
    expect(html).toMatch(/<dt>Last idle<\/dt><dd><span title="[^"]+">\d\d:\d\d/);
    expect(html).toContain(`<span class="status-label">${TEAMMATE_WORDS.idle}</span>`);
    expect(html).toContain(TEAMMATE_WORDS.staysIdle);
  });

  it('without its events: team name not reported yet, last idle —', () => {
    const html = detail(teamState(), TEAM_KEYS.alpha);
    expect(html).toContain('Teammate (team name not reported yet)');
    expect(html).toContain('<dt>Last idle</dt><dd>—</dd>');
  });

  it('shows tokens as — with the "counted on the lead" tooltip, never 0', () => {
    const html = detail(teamState(), TEAM_KEYS.alpha, [ALPHA_IDLE]);
    const esc = TEAMMATE_WORDS.tokensOnLead.replace(/'/g, '&#x27;');
    expect(html).toContain(`<dt>Tokens</dt><dd><span title="${esc}">— (counted on the lead)</span></dd>`);
    expect(html).toContain(`<p class="meter-line muted">${esc}</p>`);
    const usage = /<table class="usage-table">[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect(usage).toContain('<td>—</td>');
    expect(usage).not.toMatch(/<td>0<\/td>/);
  });

  it('a teammate that did get its own usage shows it and drops the "on the lead" line', () => {
    const usage = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requests: 1,
      estimatedCostUsd: 0.01,
    };
    const html = detail(teamState({ alpha: { usage } }), TEAM_KEYS.alpha, [ALPHA_IDLE]);
    expect(html).not.toContain('(counted on the lead)');
  });

  it('every disabled control in a teammate detail says why', () => {
    const html = detail(teamState(), TEAM_KEYS.alpha, [ALPHA_IDLE]);
    const off = [...html.matchAll(/<button[^>]*aria-disabled="true"[^>]*>/g)].map((m) => m[0]);
    expect(off.length).toBeGreaterThan(0);
    for (const b of off) expect(b).toMatch(/title="[^"]+"/);
  });

  it('the lead says how many teammates it leads and that their usage lands on it', () => {
    const html = detail(teamState(), TEAM_KEYS.lead);
    expect(html).toContain('team lead: leads 2 teammates');
    expect(html).toContain(TEAMMATE_WORDS.leadCarriesTeam.replace(/'/g, '&#x27;'));
    expect(html).not.toContain('class="team-chip"');
  });

  it('a plain subagent shows no team facts', () => {
    const html = detail(teamState(), TEAM_KEYS.helper);
    expect(html).not.toContain('team-facts');
  });
});

describe('counts with teammates', () => {
  it('idle teammates are not working and do not light the session', () => {
    const state = teamState();
    const [session] = selectTree(state);
    if (!session) throw new Error('no session');
    expect(counts(state, [session]).working).toBe(0);
    expect(sessionStatus(session)).toBe('idle');
  });

  it('a teammate working again counts as working', () => {
    const state = teamState({ alpha: { status: 'working' } });
    const sessions = selectTree(state);
    expect(counts(state, sessions).working).toBe(1);
    expect(row(tree(state), 'alpha')).toContain('alpha, teammate, working');
  });

  it('lastTeammateIdle takes the latest idle of that agent only', () => {
    const later: HuddleEvent = { ...ALPHA_IDLE, id: 'evt-0099', ts: ALPHA_IDLE.ts + 5000 };
    const other: HuddleEvent = { ...ALPHA_IDLE, id: 'evt-0100', agentKey: TEAM_KEYS.beta, ts: ALPHA_IDLE.ts + 9000 };
    expect(lastTeammateIdle([ALPHA_IDLE, later, other], TEAM_KEYS.alpha)).toEqual({
      ts: ALPHA_IDLE.ts + 5000,
      teamName: 'session-00000000',
    });
    expect(lastTeammateIdle([], TEAM_KEYS.alpha)).toBeNull();
  });
});
