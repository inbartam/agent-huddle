/**
 * U5 (M5, F25): Ask the Huddle. Render tests use renderToStaticMarkup (no DOM): states are handed in through
 * `initial`, and the steps (what is sent, how a result reads, the palette offer) are the pure functions in view/ask.ts
 * and view/palette.ts, driven with a recording `send` and query.
 */
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ASK_QUESTION_MAX,
  type AskAnswer,
  type AskErrorKind,
  type AskPreview,
  type AskStatus,
  type CommandResult,
  type HuddleCommand,
} from '@huddle/shared';
import { loadAskPreview } from './ask-query.js';
import { ASK_HISTORY_ANSWER_MAX, ASK_HISTORY_TURNS_MAX } from '@huddle/shared';
import { AskOff, AskPanel, PreviewText, type AskInitial } from './components/Ask.js';
import { ASK_SECTION_ID, SettingsPanel } from './components/SettingsPanel.js';
import { XSS } from './testing/fixture.js';
import { interactState } from './testing/interact-fixture.js';
import { fakeQuery, NOW_M5 } from './testing/m5-fixture.js';
import {
  ASK_WORDS as W,
  addTurn,
  againQuestion,
  askCommand,
  askHistory,
  historyFor,
  answerMeta,
  askControl,
  askCost,
  askKey,
  askLive,
  askRefusalKind,
  askOutcome,
  failureWords,
  prefillQuestion,
  previewFailure,
  previewSegments,
  previewSize,
  questionCounter,
  runAsk,
  SAMPLE_QUESTION,
  systemPromptSize,
  type AskFailure,
} from './view/ask.js';
import { askOffer, paletteActions, paletteKey, paletteList } from './view/palette.js';

const noop = () => undefined;

function recorder(result: CommandResult = { ok: true }) {
  const sent: HuddleCommand[] = [];
  const send = (cmd: HuddleCommand) => {
    sent.push(cmd);
    return Promise.resolve(result);
  };
  return { send, sent };
}

/** A preview built like the core's: instructions, question, summary, with offsets. */
function preview(question: string, summary: string, more: Partial<AskPreview> = {}): AskPreview {
  const instructions = 'You answer questions about the agents below. You have no tools.\n\n';
  const q = `Question: ${question}\n\n`;
  const text = instructions + q + summary;
  return {
    text,
    bytes: 3400,
    estTokens: 900,
    asOf: new Date(2026, 10, 14, 17, 4, 10).getTime(),
    truncated: false,
    parts: [
      { part: 'instructions', start: 0, end: instructions.length },
      { part: 'question', start: instructions.length, end: instructions.length + q.length },
      { part: 'summary', start: instructions.length + q.length, end: text.length },
    ],
    ...more,
  };
}

const ANSWER: AskAnswer = {
  text: 'ui-engineer has waited 6 minutes for approval of npm test.',
  model: 'claude-haiku-5-5',
  askedAt: new Date(2026, 10, 14, 17, 4, 30).getTime(),
  wallMs: 4100,
  apiMs: 3200,
  tokens: { input: 3800, output: 120 },
  costUsd: 0.001,
  sent: 'the exact text that went',
};

function panel(
  props: { enabled?: boolean; status?: AskStatus | null; initialQuestion?: string | null; initial?: AskInitial } = {},
  send = recorder().send,
) {
  return renderToStaticMarkup(
    <AskPanel
      enabled={props.enabled ?? true}
      {...(props.status !== undefined ? { status: props.status } : {})}
      query={null}
      onCommand={send}
      onClose={noop}
      onOpenSettings={noop}
      initialQuestion={props.initialQuestion ?? null}
      initial={props.initial ?? {}}
    />,
  );
}

describe('Ask is off (the default)', () => {
  it('turns the box and Ask off with the reason, and offers Turn on in Settings', () => {
    const rec = recorder();
    const html = panel({ enabled: false, initialQuestion: 'why is ui-engineer slow?' }, rec.send);
    expect(html).toContain(W.off.replace("'", '&#x27;'));
    expect(html).toMatch(/<textarea[^>]*readOnly=""[^>]*aria-disabled="true"/);
    expect(html).toMatch(/aria-disabled="true"[^>]*data-reason="Ask the Huddle is off\./);
    expect(html).toContain(`>${W.turnOn}</button>`);
    // "What would be sent" is still there to read before agreeing.
    expect(html).toContain(W.wouldSend);
    expect(html).not.toContain(W.willSend);
    expect(rec.sent).toEqual([]);
  });

  it('Turn on in Settings only opens Settings: it has no way to send ask.setEnabled', () => {
    let opened = 0;
    const el = AskOff({
      id: 'off',
      onOpenSettings: () => {
        opened += 1;
      },
    });
    const button = (el.props as { children: ReactElement[] }).children.find(
      (c): c is ReactElement<{ onClick: () => void }> => isValidElement(c) && c.type === 'button',
    );
    if (!button) throw new Error('no button');
    button.props.onClick();
    expect(opened).toBe(1);
  });

  it('askControl: off first, then empty, then too long', () => {
    expect(askControl(false, 'why?')).toEqual({ enabled: false, reason: W.off });
    expect(askControl(true, '   ')).toEqual({ enabled: false, reason: W.writeFirst });
    expect(askControl(true, 'x'.repeat(ASK_QUESTION_MAX + 1)).enabled).toBe(false);
    expect(askControl(true, 'why?')).toEqual({ enabled: true, reason: null });
  });

  it('Settings opened at the Ask section has that section id, and the switch stays as it was', () => {
    const s = interactState();
    const html = renderToStaticMarkup(<SettingsPanel state={s} onCommand={recorder().send} initialSection="ask" />);
    expect(html).toContain(`id="${ASK_SECTION_ID}"`);
    expect(html).toMatch(/id="ask-enabled"[^>]*role="switch"/);
    expect(html).not.toMatch(/id="ask-enabled"[^>]*checked=""/);
  });
});

describe('the question box', () => {
  it('shows the label, placeholder, keys line and an empty-question reason', () => {
    const html = panel();
    expect(html).toContain(`>${W.questionLabel}</label>`);
    expect(html).toContain(`maxLength="${String(ASK_QUESTION_MAX)}"`);
    expect(html).toContain(W.keys);
    expect(html).toContain(`<p class="ask-hint">${W.writeFirst}</p>`);
  });

  it('counts from 400 characters', () => {
    expect(questionCounter('x'.repeat(399))).toBeNull();
    expect(questionCounter('x'.repeat(412))).toBe('412 / 500');
    expect(panel({ initialQuestion: 'x'.repeat(450) })).toContain('450 / 500');
  });

  it('Enter and Ctrl+Enter ask; Shift+Enter and IME composition add a line', () => {
    expect(askKey({ key: 'Enter', shiftKey: false })).toBe('ask');
    expect(askKey({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe('ask');
    expect(askKey({ key: 'Enter', shiftKey: true })).toBe('none');
    expect(askKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe('none');
    expect(askKey({ key: 'a', shiftKey: false })).toBe('none');
  });

  it('sends huddle.ask with the trimmed question and nothing else', async () => {
    const rec = recorder({ ok: true, ask: ANSWER });
    const out = await runAsk(rec.send, '  why is ui-engineer slow?\n');
    expect(rec.sent).toEqual([{ type: 'huddle.ask', question: 'why is ui-engineer slow?' }]);
    expect(Object.keys(rec.sent[0] ?? {})).toEqual(['type', 'question']);
    expect(out).toEqual({ kind: 'answer', answer: ANSWER });
  });

  it('while asking: "Asking…", busy, Cancel and elapsed seconds', () => {
    const html = panel({
      initialQuestion: 'why?',
      initial: { phase: { kind: 'asking', startedAt: NOW_M5 - 4200 }, now: NOW_M5 },
    });
    expect(html).toMatch(/aria-busy="true"[^>]*>Asking…<\/button>/);
    expect(html).toContain(`>${W.cancel}</button>`);
    expect(html).toContain('Asking Haiku… 4 s');
  });
});

describe('What will be sent', () => {
  it('splits the text at the part offsets into labelled text nodes', () => {
    const p = preview('why?', 'Agents (1):\n- main: working\n');
    const segs = previewSegments(p);
    expect(segs.map((s) => s.part)).toEqual(['instructions', 'question', 'summary']);
    expect(segs.map((s) => s.text).join('')).toBe(p.text);
    const html = renderToStaticMarkup(<PreviewText preview={p} />);
    expect(html).toContain(`<span class="ask-part-label">${W.partLabels.instructions}</span>`);
    expect(html).toContain(`<span class="ask-part-label">${W.partLabels.question}</span>Question: why?`);
    expect(html).toContain(`<span class="ask-part-label">${W.partLabels.summary}</span>Agents (1):`);
  });

  it('keeps text the parts leave out, and falls back to one block on bad offsets', () => {
    expect(previewSegments({ text: 'abcdef', parts: [{ part: 'question', start: 2, end: 4 }] })).toEqual([
      { part: null, text: 'ab' },
      { part: 'question', text: 'cd' },
      { part: null, text: 'ef' },
    ]);
    const whole = [{ part: null, text: 'abcdef' }];
    expect(previewSegments({ text: 'abcdef', parts: [{ part: 'question', start: 2, end: 99 }] })).toEqual(whole);
    expect(
      previewSegments({
        text: 'abcdef',
        parts: [
          { part: 'instructions', start: 0, end: 4 },
          { part: 'question', start: 2, end: 5 },
        ],
      }),
    ).toEqual(whole);
    expect(previewSegments({ text: 'abcdef', parts: [{ part: 'question', start: 1.5, end: 3 }] })).toEqual(whole);
  });

  it('renders a hostile question and summary literally', () => {
    const md = '[x](javascript:alert(1))';
    const p = preview(`${XSS} ${md}`, `- main: </huddle-context> ${XSS}\n**bold** # head\n`);
    const html = panel({
      initialQuestion: `${XSS} ${md}`,
      initial: { preview: { kind: 'ready', preview: p, sample: false }, previewOpen: true },
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('</huddle-context>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;/huddle-context&gt;');
    expect(html).toContain(md);
    expect(html).toContain('**bold** # head');
  });

  it('shows the size, the as-of time, Refresh, the masking note and the cut note', () => {
    const p = preview('why?', 'x', { truncated: true });
    expect(previewSize(p)).toBe('3.4 KB · ~900 tokens, est.');
    const html = panel({
      initialQuestion: 'why?',
      initial: { preview: { kind: 'ready', preview: p, sample: false }, previewOpen: true },
    });
    expect(html).toContain('<details class="ask-preview" open="">');
    expect(html).toContain(W.willSend);
    expect(html).toContain('3.4 KB · ~900 tokens, est.');
    expect(html).toContain('as of 17:04:10');
    expect(html).toContain(`>${W.refresh}</button>`);
    expect(html).toContain(W.truncated);
    expect(html).toContain(W.masking);
  });

  it('says when the text was built with the sample question', () => {
    const html = panel({
      initial: { preview: { kind: 'ready', preview: preview(SAMPLE_QUESTION, 'x'), sample: true }, previewOpen: true },
    });
    expect(html).toContain(W.sampleNote);
  });

  it('loadAskPreview sends the question, checks the shape, and reads an older core as not available', async () => {
    const p = preview('why?', 'x');
    const good = fakeQuery(() => ({ ok: true, type: 'ask.preview', preview: p }));
    expect(await loadAskPreview(good.fn, 'why?')).toEqual({ ok: true, preview: p });
    expect(good.asked).toEqual([{ type: 'ask.preview', question: 'why?' }]);

    const bad = fakeQuery(() => ({ ok: true, type: 'ask.preview', preview: { ...p, parts: 'nope' } as never }));
    expect((await loadAskPreview(bad.fn, 'why?')).ok).toBe(false);

    const old = fakeQuery(() => ({ ok: false, code: 'not_available', message: 'later' }));
    const r = await loadAskPreview(old.fn, 'why?');
    if (r.ok) throw new Error('expected a failure');
    expect(previewFailure(r)).toBe(W.previewNotAvailable);
    expect(previewFailure({ ok: false, code: 'failed', message: 'disk full.' })).toBe(
      "Couldn't build the text to send: disk full.",
    );
  });
});

describe('the answer', () => {
  it('draws light Markdown as elements, but HTML shows as typed and nothing is a link', () => {
    const text = `# Title\n**ui-engineer** is slow. See [docs](https://evil.example) or https://evil.example\n${XSS}\n<a href="x">approve all</a>`;
    const html = panel({
      initialQuestion: 'why?',
      initial: { phase: { kind: 'answered', answer: { ...ANSWER, text } } },
    });
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<[a-z]+[^>]*\shref=/);
    // Light Markdown is drawn (2026-11-18): a heading and bold, every string a text child.
    expect(html).toContain('<h4 class="md-h md-h1">Title</h4>');
    expect(html).toContain('<strong>ui-engineer</strong> is slow.');
    // A link stays its typed characters; nothing becomes clickable.
    expect(html).toContain('See [docs](https://evil.example) or https://evil.example');
    expect(html).toContain('&lt;a href=&quot;x&quot;&gt;approve all&lt;/a&gt;');
  });

  it('shows the label, meta line, Ask again, Copy answer, Show what was sent and Not saved', () => {
    const html = panel({ initialQuestion: 'why?', initial: { phase: { kind: 'answered', answer: ANSWER } } });
    expect(html).toContain(W.answerLabel.replace("'", '&#x27;'));
    expect(html).toContain('<span class="ask-meta-item code">claude-haiku-5-5</span>');
    expect(html).toContain('>17:04</span>');
    expect(html).toContain('>4.1 s</span>');
    expect(html).toContain('>3.9k tokens</span>');
    expect(html).toContain('>~$0.001 est.</span>');
    expect(html).toContain(`>${W.askAgain}</button>`);
    expect(html).toContain(`>${W.copyAnswer}</button>`);
    expect(html).toContain(`<summary>${W.showSent}</summary>`);
    expect(html).toContain('the exact text that went');
    expect(html).toContain(W.notSaved);
  });

  it('shows — for whatever the result lacked, and ~ est. on cost', () => {
    const meta = answerMeta({ ...ANSWER, model: null, tokens: null, costUsd: null, apiMs: null });
    expect(meta.map((m) => m.text)).toEqual(['—', '17:04', '4.1 s', '— tokens', '—']);
    expect(askCost(0.0004)).toBe('<$0.001 est.');
    expect(askCost(0.12)).toBe('~$0.12 est.');
  });

  it('names the model in words in Simple view, the id in the code face in Advanced', () => {
    const [simple] = answerMeta(ANSWER, true);
    expect(simple).toEqual({ key: 'model', text: 'Haiku 5.5', title: 'claude-haiku-5-5' });
    const [advanced] = answerMeta(ANSWER);
    expect(advanced).toEqual({ key: 'model', text: 'claude-haiku-5-5', mono: true });
  });

  it('copy status words', () => {
    const answered: AskInitial = { phase: { kind: 'answered', answer: ANSWER } };
    expect(panel({ initial: { ...answered, copy: 'copied' } })).toContain(W.copied);
    expect(panel({ initial: { ...answered, copy: 'failed' } })).toContain('The answer is selected: press Ctrl+C.');
  });
});

describe('errors in plain words', () => {
  const kinds: Record<AskErrorKind, string> = {
    claude_not_found:
      "Huddle couldn't find the `claude` command. Install Claude Code, or add it to PATH, then ask again.",
    not_logged_in: "Claude Code isn't logged in. Run `claude` in a terminal, log in, then ask again.",
    timeout: 'No answer within 30 seconds. Ask again, or ask something shorter.',
    model_error: "Claude Code couldn't answer: overloaded.",
    disabled: 'Stopped: Ask the Huddle was turned off.',
    api_key_set:
      "ANTHROPIC_API_KEY is set on this computer (in the environment, or in Claude Code's settings.json with an auth token or apiKeyHelper), so the ask would be billed to that key instead of your Claude Code login. Huddle won't send it. Remove it and restart Huddle to ask.",
    other_provider:
      "Claude Code on this computer is set to use another provider (ANTHROPIC_BASE_URL, Bedrock, Vertex or Foundry), so the summary would not go to Anthropic. Huddle won't send it. Remove the setting and restart Huddle to ask.",
    cancelled: 'Cancelled. Nothing was answered.',
    busy: 'Another question is still being answered. Wait for it, or cancel it.',
  };

  it.each(Object.entries(kinds))('%s', (kind, words) => {
    const out = askOutcome({ ok: false, code: 'failed', message: 'overloaded.', askError: kind as AskErrorKind });
    if (out.kind !== 'failed') throw new Error('expected a failure');
    expect(out.failure.kind).toBe(kind);
    expect(failureWords(out.failure).text).toBe(words);
    expect(failureWords(out.failure).alert).toBe(kind !== 'cancelled');
  });

  it('clips a long model error to one line', () => {
    const f: AskFailure = { kind: 'model_error', message: `line one\n${'x'.repeat(1000)}` };
    const t = failureWords(f).text;
    expect(t.length).toBeLessThan(360);
    expect(t).not.toContain('\n');
  });

  it('an older core: no askError, or ok without an answer, reads as not available', () => {
    for (const r of [
      { ok: false, code: 'unsupported', message: 'nope' },
      { ok: false, code: 'invalid', message: 'bad command' },
      { ok: true },
      { ok: true, ask: { text: 1 } },
    ] as CommandResult[]) {
      const out = askOutcome(r);
      if (out.kind !== 'failed') throw new Error('expected a failure');
      expect(failureWords(out.failure).text).toBe("Ask the Huddle isn't available in this build.");
    }
    const other = askOutcome({ ok: false, code: 'failed', message: 'boom.' });
    if (other.kind !== 'failed') throw new Error('expected a failure');
    expect(failureWords(other.failure).text).toBe("Huddle couldn't ask: boom.");
  });

  it('a thrown bridge call reads as an error, not an answer', async () => {
    const out = await runAsk(() => Promise.reject(new Error('gone')), 'why?');
    expect(out.kind).toBe('failed');
  });

  it('renders as role=alert with the command in the code face, the question kept in the box', () => {
    const html = panel({
      initialQuestion: 'why is it slow?',
      initial: { phase: { kind: 'failed', failure: { kind: 'claude_not_found', message: '' } } },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('<span class="code">claude</span>');
    expect(html).toContain('>why is it slow?</textarea>');
  });

  it('busy offers Cancel; cancelled is a status line, not an alert', () => {
    const busy = panel({ initial: { phase: { kind: 'failed', failure: { kind: 'busy', message: '' } } } });
    expect(busy).toContain(`>${W.cancel}</button>`);
    const cancelled = panel({ initial: { phase: { kind: 'failed', failure: { kind: 'cancelled', message: '' } } } });
    expect(cancelled).toMatch(/class="ask-note" role="status">Cancelled\./);
    expect(cancelled).not.toContain('role="alert"');
  });
});

/** renderToStaticMarkup escapes ' as &#x27;. */
const esc = (s: string) => s.replace(/'/g, '&#x27;');
const KEY_WORDS = failureWords({ kind: 'api_key_set', message: '' }).text;
const BUSY_WORDS = failureWords({ kind: 'busy', message: '' }).text;
const status = (over: Partial<AskStatus> = {}): AskStatus => ({
  enabled: true,
  apiKeySet: false,
  busy: false,
  ...over,
});
const occurrences = (html: string, s: string) => html.split(s).length - 1;

describe('up-front state (HuddleState.ask, U6)', () => {
  it('apiKeySet: the refusal words show and Ask is off before anything is sent; the box stays usable', () => {
    const rec = recorder();
    const html = panel({ status: status({ apiKeySet: true }), initialQuestion: 'why?' }, rec.send);
    expect(html).toContain(`>${esc(KEY_WORDS)}</p>`);
    expect(html).toMatch(/aria-disabled="true"[^>]*data-reason="ANTHROPIC_API_KEY is set on this computer/);
    expect(html).not.toMatch(/<textarea[^>]*readOnly/);
    expect(html).toContain('>why?</textarea>');
    // The box is described by the API key line; no "write a question" hint under it.
    expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]*-key [^"]*-keys"/);
    expect(html).not.toContain('class="ask-hint"');
    // Ask cannot send it, so the disclosure reads "What would be sent".
    expect(html).toContain(W.wouldSend);
    expect(rec.sent).toEqual([]);
    expect(askControl(true, 'why?', { apiKeySet: true })).toEqual({ enabled: false, reason: KEY_WORDS });
  });

  it('otherProvider (L1): its own refusal words show up front and Ask is off; a refused ask says it once', () => {
    const OTHER_WORDS = failureWords({ kind: 'other_provider', message: '' }).text;
    const rec = recorder();
    const html = panel({ status: status({ otherProvider: true }), initialQuestion: 'why?' }, rec.send);
    expect(html).toContain(`>${esc(OTHER_WORDS)}</p>`);
    expect(html).not.toContain(esc(KEY_WORDS));
    expect(html).toMatch(
      /aria-disabled="true"[^>]*data-reason="Claude Code on this computer is set to use another provider/,
    );
    expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]*-key [^"]*-keys"/);
    expect(html).toContain(W.wouldSend);
    expect(rec.sent).toEqual([]);
    expect(askControl(true, 'why?', { otherProvider: true })).toEqual({ enabled: false, reason: OTHER_WORDS });
    const refused = panel({
      status: status({ otherProvider: true }),
      initialQuestion: 'why?',
      initial: { phase: { kind: 'failed', failure: { kind: 'other_provider', message: '' } } },
    });
    expect(occurrences(refused, `>${esc(OTHER_WORDS)}</p>`)).toBe(1);
    // A billed key is named first when both are set.
    expect(askRefusalKind(askLive(status({ apiKeySet: true, otherProvider: true }), true))).toBe('api_key_set');
  });

  it('apiKeySet and a refused ask with api_key_set say it once', () => {
    const html = panel({
      status: status({ apiKeySet: true }),
      initialQuestion: 'why?',
      initial: { phase: { kind: 'failed', failure: { kind: 'api_key_set', message: '' } } },
    });
    expect(occurrences(html, `>${esc(KEY_WORDS)}</p>`)).toBe(1);
  });

  it('busy from state: "Another question is still being answered" with Cancel, though this view did not ask', () => {
    const html = panel({ status: status({ busy: true }), initialQuestion: 'why?' });
    expect(html).toContain(`<p class="ask-note" role="status">${BUSY_WORDS}</p>`);
    expect(html).toMatch(/class="ask-failure ask-busy">.*>Cancel<\/button>/);
    expect(html).toMatch(/aria-disabled="true"[^>]*data-reason="Another question is still being answered\./);
    expect(askControl(true, 'why?', { busy: true })).toEqual({ enabled: false, reason: BUSY_WORDS });
  });

  it('busy from state and a refused ask with busy say it once; this view asking is not "another question"', () => {
    const refused = panel({
      status: status({ busy: true }),
      initial: { phase: { kind: 'failed', failure: { kind: 'busy', message: '' } } },
    });
    expect(occurrences(refused, `>${BUSY_WORDS}</p>`)).toBe(1);
    expect(occurrences(refused, `>${W.cancel}</button>`)).toBe(1);

    const own = panel({
      status: status({ busy: true }),
      initialQuestion: 'why?',
      initial: { phase: { kind: 'asking', startedAt: NOW_M5 - 1000 }, now: NOW_M5 },
    });
    expect(own).not.toContain(BUSY_WORDS);
    expect(own).toMatch(/aria-busy="true"[^>]*>Asking…<\/button>/);
    expect(occurrences(own, `>${W.cancel}</button>`)).toBe(1);
  });

  it('state.ask.enabled wins over the settings value when they disagree', () => {
    expect(askLive(status({ enabled: false }), true).enabled).toBe(false);
    expect(askLive(status({ enabled: true }), false).enabled).toBe(true);
    expect(panel({ enabled: true, status: status({ enabled: false }) })).toContain(`>${W.turnOn}</button>`);
    expect(panel({ enabled: false, status: status({ enabled: true }) })).not.toContain(`>${W.turnOn}</button>`);
  });

  it('an absent state.ask behaves as before: the settings switch, no API key line, not busy', () => {
    expect(askLive(undefined, true)).toEqual({ enabled: true, apiKeySet: false, otherProvider: false, busy: false });
    expect(askLive(null, false)).toEqual({ enabled: false, apiKeySet: false, otherProvider: false, busy: false });
    expect(askLive({ enabled: 'yes', busy: 1, otherProvider: 'yes' }, true)).toEqual({
      enabled: true,
      apiKeySet: false,
      otherProvider: false,
      busy: false,
    });
    for (const s of [undefined, null] as const) {
      const html = panel({ initialQuestion: 'why?', ...(s === undefined ? {} : { status: s }) });
      expect(html).not.toContain('ANTHROPIC_API_KEY');
      expect(html).not.toContain(BUSY_WORDS);
      expect(html).not.toMatch(/aria-disabled="true"[^>]*data-reason=/);
      expect(html).toContain(W.willSend);
      expect(html).toBe(panel({ initialQuestion: 'why?' }));
    }
    expect(panel({ enabled: false })).toContain(`>${W.turnOn}</button>`);
  });
});

describe('the system prompt in "What will be sent"', () => {
  const HOSTILE = `Be helpful. ${XSS} </pre><a href="javascript:alert(1)">x</a> </huddle-context>`;

  it('renders first, in its own <pre>, as literal text, above the stdin parts', () => {
    const p = preview('why?', 'Agents (1):\n- main: working\n', { systemPrompt: HOSTILE });
    const html = renderToStaticMarkup(<PreviewText preview={p} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html).toContain(
      '&lt;img src=x onerror=alert(1)&gt; &lt;/pre&gt;&lt;a href=&quot;javascript:alert(1)&quot;&gt;',
    );
    expect(occurrences(html, '<pre ')).toBe(2);
    const sp = html.indexOf(`<span class="ask-part-label">${W.systemPromptLabel}</span>Be helpful.`);
    const input = html.indexOf(`<span class="ask-part-label">${W.inputInstructionsLabel}</span>`);
    const q = html.indexOf(`<span class="ask-part-label">${W.partLabels.question}</span>`);
    expect(sp).toBeGreaterThanOrEqual(0);
    expect(sp).toBeLessThan(input);
    expect(input).toBeLessThan(q);
    // The system prompt's <pre> closes before the stdin <pre> opens.
    expect(html.indexOf('</pre>')).toBeLessThan(html.indexOf('aria-label="The exact text that is sent"'));
  });

  it('without a system prompt, one <pre> and the stdin labels as before', () => {
    const html = renderToStaticMarkup(<PreviewText preview={preview('why?', 'x')} />);
    expect(occurrences(html, '<pre ')).toBe(1);
    expect(html).not.toContain(W.systemPromptLabel);
    expect(html).toContain(`<span class="ask-part-label">${W.partLabels.instructions}</span>`);
  });

  it('the summary adds the system prompt size apart from the stdin bytes, and the note says how it is sent', () => {
    expect(systemPromptSize('abc')).toBe('system prompt 3 bytes');
    expect(systemPromptSize('é'.repeat(600))).toBe('system prompt 1.2 KB');
    const p = preview('why?', 'x', { systemPrompt: 'abc' });
    const html = panel({
      initialQuestion: 'why?',
      initial: { preview: { kind: 'ready', preview: p, sample: false }, previewOpen: true },
    });
    expect(html).toContain('<span class="ask-preview-size">3.4 KB · ~900 tokens, est.</span>');
    expect(html).toContain('<span class="ask-preview-size">system prompt 3 bytes</span>');
    expect(html).toContain(W.systemPromptNote);
    const without = panel({
      initialQuestion: 'why?',
      initial: { preview: { kind: 'ready', preview: preview('why?', 'x'), sample: false }, previewOpen: true },
    });
    expect(without).not.toContain('system prompt');
  });

  it('loadAskPreview keeps a string systemPrompt, and refuses one that is not text', async () => {
    const p = preview('why?', 'x', { systemPrompt: HOSTILE });
    const good = fakeQuery(() => ({ ok: true, type: 'ask.preview', preview: p }));
    expect(await loadAskPreview(good.fn, 'why?')).toEqual({ ok: true, preview: p });
    const bad = fakeQuery(() => ({ ok: true, type: 'ask.preview', preview: { ...p, systemPrompt: 42 } as never }));
    expect((await loadAskPreview(bad.fn, 'why?')).ok).toBe(false);
  });
});

describe('palette', () => {
  it('Ask the Huddle… opens Ask with an empty box', () => {
    const a = paletteActions(interactState(), new Map()).find((x) => x.id === 'ask');
    expect(a).toMatchObject({ label: 'Ask the Huddle…', effect: { kind: 'ask', question: null } });
  });

  it('the no-match offer fills the box and is not a command', () => {
    const actions = paletteActions(interactState(), new Map());
    const list = paletteList(actions, 'why is zqxj so slow');
    expect(list).toHaveLength(1);
    const offer = list[0];
    if (!offer) throw new Error('no offer');
    expect(offer.label).toBe('Ask the Huddle: “why is zqxj so slow”');
    expect(offer.effect).toEqual({ kind: 'ask', question: 'why is zqxj so slow' });
    const r = paletteKey('Enter', 0, list, true);
    expect(r.kind).toBe('run');
    if (r.kind === 'run') expect(r.action.effect.kind).not.toBe('command');
    // A match lists the actions, not the offer; empty text offers nothing.
    expect(paletteList(actions, 'history').some((a) => a.id === 'ask.offer')).toBe(false);
    expect(askOffer('   ')).toBeNull();
  });

  it('the prefill is clipped to the limit and rendering it sends nothing', () => {
    const long = 'y'.repeat(ASK_QUESTION_MAX + 40);
    expect(askOffer(long)?.effect).toEqual({ kind: 'ask', question: 'y'.repeat(ASK_QUESTION_MAX) });
    expect(askOffer(long)?.label.length).toBeLessThan(100);
    expect(prefillQuestion(long)).toHaveLength(ASK_QUESTION_MAX);
    const rec = recorder();
    const html = panel({ initialQuestion: `why? ${XSS}` }, rec.send);
    expect(html).toContain('>why? &lt;img src=x onerror=alert(1)&gt;</textarea>');
    expect(rec.sent).toEqual([]);
  });
});

describe('the conversation (Home card)', () => {
  const turn = (q: string, a = `answer to ${q}`) => ({ question: q, answer: { ...ANSWER, text: a } });

  it('a follow-up carries the newest turns, oldest first, clipped; Ask again leaves the last one out', () => {
    const turns = [turn('one'), turn('two'), turn('three'), turn('four', 'z'.repeat(ASK_HISTORY_ANSWER_MAX + 50))];
    const h = askHistory(turns);
    expect(h).toHaveLength(ASK_HISTORY_TURNS_MAX);
    expect(h.map((t) => t.question)).toEqual(['two', 'three', 'four']);
    expect(h[2]?.answer).toHaveLength(ASK_HISTORY_ANSWER_MAX);
    expect(historyFor(turns, true).map((t) => t.question)).toEqual(['one', 'two', 'three']);
    expect(historyFor([], false)).toEqual([]);
  });

  it('adds a turn, or replaces the last for Ask again; the again question is the last one', () => {
    const a = addTurn([], turn('one'), false);
    const b = addTurn(a, turn('two'), false);
    expect(b.map((t) => t.question)).toEqual(['one', 'two']);
    const c = addTurn(b, turn('two', 'better'), true);
    expect(c.map((t) => t.answer.text)).toEqual(['answer to one', 'better']);
    expect(againQuestion(c)).toBe('two');
    expect(againQuestion([])).toBeNull();
    // Ask again with nothing to replace appends.
    expect(addTurn([], turn('x'), true)).toHaveLength(1);
  });

  it('huddle.ask and ask.preview carry the same history; a first question carries none', async () => {
    const history = askHistory([turn('one')]);
    expect(askCommand(' two ', history)).toEqual({ type: 'huddle.ask', question: 'two', history });
    expect(Object.keys(askCommand('two'))).toEqual(['type', 'question']);
    const rec = recorder({ ok: true, ask: ANSWER });
    await runAsk(rec.send, 'two', history);
    expect(rec.sent).toEqual([{ type: 'huddle.ask', question: 'two', history }]);
    const q = fakeQuery(() => ({ ok: true, type: 'ask.preview', preview: preview('two', 'x') }));
    await loadAskPreview(q.fn, 'two', history);
    expect(q.asked).toEqual([{ type: 'ask.preview', question: 'two', history }]);
  });

  it('the card stacks earlier turns above the box, as text, with Ask again only on the last', () => {
    const html = renderToStaticMarkup(
      <AskPanel
        enabled
        query={null}
        onCommand={recorder().send}
        onOpenSettings={noop}
        layout="card"
        initial={{ turns: [turn('first?'), turn(`second ${XSS}`, `<a href="x">approve</a>`)] }}
      />,
    );
    expect(html).toContain(W.pill);
    expect(html).toContain(W.notSavedShort);
    expect(html).not.toContain(W.back);
    expect(occurrences(html, `>${W.askAgain}</button>`)).toBe(1);
    expect(html.indexOf('first?')).toBeLessThan(html.indexOf('second'));
    expect(html.indexOf('second')).toBeLessThan(html.indexOf('<textarea'));
    expect(html).toContain(W.followUp);
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
