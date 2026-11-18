/**
 * Setup status in the renderer (ADR-017): the consent screen renders the diff, path and warnings as text,
 * the token never appears, and the widget and banner say what to do.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, ConnectionStatus, HuddleState } from '@huddle/shared';
import type { HuddleBridge } from '../../preload/api.js';
import {
  CONSENT_WHAT,
  ConnectionBanner,
  ConsentScreen,
  diffRows,
  InlineCodeText,
  WIDGET_NOT_CONNECTED,
  WidgetConnectionRow,
} from './components/Connection.js';
import { HuddleStore } from './store.js';
import { fixtureState } from './testing/fixture.js';
import { WidgetBody } from './views/WidgetView.js';

const noop = () => undefined;
const SECRET = 'real-token-abc123XYZ';

const DIFF = [
  '  {',
  '+   "hooks": {',
  '+     "PreToolUse": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:47821/huddle/hooks/PreToolUse",',
  '+       "headers": { "X-Huddle-Token": "<token>" } }] }],',
  '-   "note": "<img src=x onerror=alert(1)>",',
  '  ...',
  '  }',
].join('\n');

const preview = {
  settingsPath: 'C:\\Users\\u\\.claude\\settings.json',
  diffText: DIFF,
  warnings: ['Telemetry is already configured <b>by you</b>; Huddle leaves it alone.'],
};

function consent(extra: Partial<Parameters<typeof ConsentScreen>[0]> = {}) {
  return renderToStaticMarkup(
    <ConsentScreen
      preview={preview}
      notice={null}
      error={null}
      busy={false}
      onConnect={noop}
      onLater={noop}
      {...extra}
    />,
  );
}

describe('consent screen', () => {
  it('explains the change, shows the file, the diff as text and the warnings', () => {
    const html = consent();
    expect(html).toContain(CONSENT_WHAT.replace("'", '&#x27;'));
    expect(html).toContain('C:\\Users\\u\\.claude\\settings.json');
    expect(html).toContain('3 lines added, 1 removed');
    // Markup inside the diff and the warnings is escaped text, never elements.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;b&gt;by you&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    // The token is a placeholder; the real token never reaches the screen.
    expect(html).toContain('&lt;token&gt;');
    expect(html).not.toContain(SECRET);
    expect(html).toMatch(/<button[^>]*>Connect<\/button>/);
    expect(html).toMatch(/<button[^>]*>Not now<\/button>/);
  });

  it('marks added and removed lines with a sign and a hidden label, not colour alone', () => {
    const html = consent();
    expect(html).toContain('class="diff-row op-add"');
    expect(html).toContain('class="diff-row op-del"');
    expect(html).toContain('added: </span>');
    expect(html).toContain('removed: </span>');
    expect(html).toContain('>−</span>');
  });

  it('shows why it asks again after the settings changed, and disables buttons while connecting', () => {
    const html = consent({ notice: 'Your Claude Code settings changed since this was shown.', busy: true });
    expect(html).toContain('settings changed since this was shown');
    expect(html).toContain('Connecting…');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it('parses the diff rows, including the gap marker', () => {
    expect(diffRows(DIFF).map((r) => r.op)).toEqual([' ', '+', '+', '+', '-', 'gap', ' ']);
    expect(diffRows('')).toEqual([]);
  });
});

describe('connection banner and widget row', () => {
  const portInUse: ConnectionStatus = {
    status: 'port_in_use',
    message: 'Port 47821 is in use, probably by another Agent Huddle or another program. Close it and restart Huddle.',
  };
  const needsConsent: ConnectionStatus = { status: 'needs_consent', message: 'x', preview };

  it('shows the port message calmly with a cross glyph, and offers review for consent', () => {
    const port = renderToStaticMarkup(<ConnectionBanner connection={portInUse} />);
    expect(port).toContain(
      'Port 47821 is in use, probably by another Agent Huddle or another program. Close it and restart Huddle.',
    );
    // Backticked parts become code text; markup inside stays text; unpaired backticks are left as typed.
    expect(renderToStaticMarkup(<InlineCodeText text="run `<i>x</i>` now" />)).toBe(
      'run <code class="code">&lt;i&gt;x&lt;/i&gt;</code> now',
    );
    expect(renderToStaticMarkup(<InlineCodeText text="a `b` c `d" />)).toBe('a `b` c `d');
    expect(port).toContain('role="alert"');
    const later = renderToStaticMarkup(<ConnectionBanner connection={needsConsent} onReview={noop} />);
    expect(later).toContain('Review changes');
    expect(renderToStaticMarkup(<ConnectionBanner connection={{ status: 'attached', message: null }} />)).toBe('');
  });

  it('the widget says "Not connected" and nothing more when consent is needed', () => {
    const row = renderToStaticMarkup(<WidgetConnectionRow connection={needsConsent} onOpenMain={noop} />);
    expect(row).toContain(WIDGET_NOT_CONNECTED);
    expect(row).not.toContain('settings.json');
    const state: HuddleState = { ...fixtureState(), connection: needsConsent };
    const widget = renderToStaticMarkup(
      <WidgetBody
        state={state}
        error={null}
        renames={new Map()}
        opened={new Set()}
        onToggle={noop}
        onOpenMain={noop}
      />,
    );
    expect(widget).toContain(WIDGET_NOT_CONNECTED);
    const attached = renderToStaticMarkup(
      <WidgetBody
        state={{ ...fixtureState(), connection: { status: 'attached', message: null } }}
        error={null}
        renames={new Map()}
        opened={new Set()}
        onToggle={noop}
        onOpenMain={noop}
      />,
    );
    expect(attached).not.toContain('Not connected');
  });
});

describe('store.attach', () => {
  it('sends setup.attach and reads the state again', async () => {
    const getState = vi.fn(() => Promise.resolve(fixtureState()));
    const command = vi.fn((): Promise<CommandResult> =>
      Promise.resolve({ ok: false, code: 'expired', message: 'changed' }),
    );
    const bridge: HuddleBridge = {
      getState,
      command,
      getEvents: () => Promise.resolve([]),
      onEvents: () => noop,
      query: () => Promise.resolve({ ok: false, code: 'unsupported', message: 'not in this test' }),
    };
    const store = new HuddleStore(bridge);
    const result = await store.attach();
    expect(command).toHaveBeenCalledWith({ type: 'setup.attach' });
    expect(result).toEqual({ ok: false, code: 'expired', message: 'changed' });
    expect(getState).toHaveBeenCalledTimes(1);
  });
});
