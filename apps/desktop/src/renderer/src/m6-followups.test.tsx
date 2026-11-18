/**
 * M6 desktop follow-ups (owner decisions 2026-11-16): the widget's hide control, Settings "Ask the lead about idle
 * teammates" (`teams.askLeadOnIdle`), the usage column "With team (N)" for a lead, and a message the Huddle wrote
 * itself labelled "Automatic check by Agent Huddle" in the outbox.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type HuddleState } from '@huddle/shared';
import { MessageSection } from './components/AgentControls.js';
import { UsageSection } from './components/Meters.js';
import { SettingsPanel, TEAMS_SECTION_ID } from './components/SettingsPanel.js';
import { IK, interactState } from './testing/interact-fixture.js';
import { TEAM_KEYS, teamState } from './testing/team-fixture.js';
import { MESSAGE_AUTHOR_WORDS, messageAuthorWords } from './view/composer.js';
import { askLeadOnIdle, askLeadOnIdleCommand, TEAM_SETTINGS_WORDS } from './view/settings.js';
import { usageRollupHead } from './view/teammates.js';
import { HIDE_WIDGET_HINT, WidgetBody } from './views/WidgetView.js';

const ok = () => Promise.resolve({ ok: true as const });
const noop = () => undefined;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

const USAGE = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requests: 2,
  estimatedCostUsd: 0.01,
  requestsWithoutCost: 0,
  requestsWithoutId: 0,
};

function widget(props: { onHideWidget?: () => void }) {
  return renderToStaticMarkup(
    <WidgetBody
      state={interactState()}
      error={null}
      renames={new Map()}
      opened={new Set()}
      onToggle={noop}
      onOpenMain={noop}
      now={0}
      {...props}
    />,
  );
}

describe('widget hide control', () => {
  it('is a labelled button in the header (keyboard reachable: a real <button>, no tabindex trick)', () => {
    const html = widget({ onHideWidget: noop });
    const button = new RegExp(
      `<button type="button" class="icon-button" title="${escape(HIDE_WIDGET_HINT)}" aria-label="${escape(HIDE_WIDGET_HINT)}">`,
    );
    expect(html).toMatch(button);
    expect(html.indexOf(HIDE_WIDGET_HINT.slice(0, 15))).toBeLessThan(html.indexOf('</header>'));
    expect(HIDE_WIDGET_HINT).toContain('tray');
  });

  it('is not shown where nothing can hide the window (tests, other hosts)', () => {
    expect(widget({})).not.toContain(escape(HIDE_WIDGET_HINT));
  });
});

describe('Settings: ask the lead about idle teammates', () => {
  function panel(state: HuddleState) {
    return renderToStaticMarkup(<SettingsPanel state={state} onCommand={ok} />);
  }

  it('is on by default, with what it does and where it works', () => {
    const state = interactState();
    state.settings = { ...DEFAULT_USER_SETTINGS };
    const html = panel(state);
    expect(html).toContain(`id="${TEAMS_SECTION_ID}"`);
    expect(html).toContain(`>${TEAM_SETTINGS_WORDS.label}</label>`);
    expect(html).toMatch(
      /id="teams-ask-lead" type="checkbox" role="switch" class="switch" aria-describedby="[^"]*" checked=""/,
    );
    expect(html).toContain('aria-describedby="teams-ask-lead-what teams-ask-lead-where"');
    expect(html).toContain(escape(TEAM_SETTINGS_WORDS.what));
    expect(html).toContain(escape(TEAM_SETTINGS_WORDS.where));
    expect(TEAM_SETTINGS_WORDS.what).toContain('one message');
    expect(TEAM_SETTINGS_WORDS.what).toContain('report_teammate');
    expect(TEAM_SETTINGS_WORDS.where).toContain('registered');
    expect(TEAM_SETTINGS_WORDS.where).toContain('few tokens');
    expect(TEAM_SETTINGS_WORDS.where).toContain('wake a stopped lead');
  });

  it('shows off when the settings say off, and the default when the core sends no teams', () => {
    const state = interactState();
    state.settings = { ...DEFAULT_USER_SETTINGS, teams: { askLeadOnIdle: false } };
    expect(panel(state)).toMatch(
      /id="teams-ask-lead" type="checkbox" role="switch" class="switch" aria-describedby="[^"]*"\/>/,
    );
    expect(askLeadOnIdle(state.settings)).toBe(false);
    const { teams: _omit, ...older } = DEFAULT_USER_SETTINGS;
    expect(askLeadOnIdle(older)).toBe(true);
    expect(askLeadOnIdle(undefined)).toBe(true);
  });

  it('sends one settings.update patch', () => {
    expect(askLeadOnIdleCommand(false)).toEqual({
      type: 'settings.update',
      patch: { teams: { askLeadOnIdle: false } },
    });
  });
});

describe('usage column head', () => {
  it('reads "With team (N)" for a lead with teammates', () => {
    const state = teamState({ lead: { usage: USAGE }, helper: { usage: USAGE } });
    const lead = state.agents[TEAM_KEYS.lead];
    if (!lead) throw new Error('no lead');
    const html = renderToStaticMarkup(<UsageSection state={state} agent={lead} />);
    expect(html).toMatch(/With team \(\d+\)/);
    expect(html).not.toContain('With subagents');
  });

  it('stays "With subagents (N)" without teammates', () => {
    const state = interactState({ agents: { main: { usage: USAGE }, tester: { usage: USAGE } } });
    const main = state.agents[IK.main];
    if (!main) throw new Error('no main');
    const html = renderToStaticMarkup(<UsageSection state={state} agent={main} />);
    expect(html).toMatch(/With subagents \(\d+\)/);
    expect(html).not.toContain('With team');
  });

  it('words', () => {
    expect(usageRollupHead(true, 4)).toBe('With team (4)');
    expect(usageRollupHead(false, 5)).toBe('With subagents (5)');
  });
});

describe('outbox: who wrote a message', () => {
  function outbox(state: HuddleState) {
    const agent = state.agents[IK.main];
    if (!agent) throw new Error('no agent');
    return renderToStaticMarkup(<MessageSection state={state} agent={agent} onCommand={ok} />);
  }

  it('labels the lead check "Automatic check by Agent Huddle", and the user\'s own messages "From you"', () => {
    const state = interactState({
      agents: {
        main: {
          outbox: [
            { messageId: 'm-1', text: 'Keep it under one page.', delivery: 'next_tool', queuedAt: 1_000 },
            {
              messageId: 'm-2',
              text: 'Agent Huddle (an automatic check, not a message from the user): teammate "<b>x</b>" is idle.',
              delivery: 'auto',
              queuedAt: 2_000,
              author: 'huddle',
            },
          ],
        },
      },
    });
    const html = outbox(state);
    const rows = [...html.matchAll(/<li class="outbox-row[^"]*">[\s\S]*?<\/li>/g)].map((m) => m[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`>${MESSAGE_AUTHOR_WORDS.user}</span>`);
    expect(rows[0]).not.toContain(MESSAGE_AUTHOR_WORDS.huddle);
    expect(rows[1]).toContain('class="outbox-row is-automatic"');
    expect(rows[1]).toContain(`>${MESSAGE_AUTHOR_WORDS.huddle}</span>`);
    expect(rows[1]).not.toContain(MESSAGE_AUTHOR_WORDS.user);
    // The text came from an agent's name: a text node, never markup.
    expect(rows[1]).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(rows[1]).not.toContain('<b>x</b>');
  });

  it('messageAuthorWords', () => {
    expect(messageAuthorWords({ author: 'huddle' })).toBe('Automatic check by Agent Huddle');
    expect(messageAuthorWords({})).toBe('From you');
  });
});
