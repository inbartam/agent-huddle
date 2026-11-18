// @vitest-environment happy-dom
/**
 * The phone page (M6, F26) in happy-dom: pairing stores the token (and copes without storage), the stream is read
 * with the token in the header only, views render as text (hostile names stay text), Allow and the inline Deny
 * confirmation post the decision, a 401 anywhere drops the token and shows pairing with a sentence, a broken stream
 * falls back to /api/state and reconnects with backoff, and Forget drops the token.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PHONE_TEXT_MAX, type PhoneQuestionView, type PhoneView } from '@huddle/shared';
import { PhoneApp, TOKEN_KEY, type FetchLike, type ResponseLike, type StorageLike } from './app.js';
import { parsePhoneView } from './view-data.js';
import { PHONE_WORDS as W } from './words.js';

const XSS = '<img src=x onerror=alert(1)>';
const TOKEN = 'tok_ABCdef-123';
const CREDS = JSON.stringify({ deviceId: 'd'.repeat(32), token: TOKEN });
const T = Date.UTC(2026, 10, 16, 12, 0, 0);
const ON = { enabled: true, reason: null };
const off = (reason: string) => ({ enabled: false, reason });
const NO_STOP = 'Only runs Huddle launched can be stopped or ended from here. Use the terminal for this one.';
const NOT_PAUSED = "This agent isn't paused.";

const VIEW: PhoneView = {
  generatedAt: T,
  sessions: [
    {
      rootKey: 's1',
      title: XSS,
      project: 'agent-huddle',
      agents: [
        {
          key: 's1',
          parentKey: null,
          depth: 0,
          name: 'main',
          role: '',
          status: 'working',
          progress: { fraction: 0.4, label: '2 of 5 tasks' },
          activity: `Bash: npm test ${XSS}`,
          controls: { message: ON, pause: ON, resume: off(NOT_PAUSED), stop: off(NO_STOP) },
          messageLands: 'after the next tool call or when this turn ends',
        },
        {
          key: 's1/a',
          parentKey: 's1',
          depth: 1,
          name: XSS,
          role: 'Explore',
          status: 'waiting_approval',
          progress: { fraction: null, label: null },
          activity: null,
          controls: { message: ON, pause: ON, resume: off(NOT_PAUSED), stop: off(NO_STOP) },
          messageLands: 'after the next tool call',
        },
      ],
    },
  ],
  inbox: [
    {
      kind: 'approval',
      id: 'i1',
      requestId: 'req-1',
      agentKey: 's1/a',
      agentName: XSS,
      toolName: 'Bash',
      summary: `rm -rf / ${XSS}`,
      hidden: false,
      createdAt: T,
      expiresAt: null,
    },
    {
      kind: 'stuck',
      id: 'i2',
      agentKey: 's1',
      agentName: 'main',
      title: 'No progress for 6 min',
      createdAt: T,
    },
  ],
};

interface Call {
  url: string;
  init: RequestInit;
}

function memoryStorage(initial?: string): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(TOKEN_KEY, initial);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function json(status: number, body: unknown): ResponseLike {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body), body: null };
}

/** A stream response the test writes SSE text into. */
function stream(): { res: ResponseLike; write: (s: string) => void; end: () => void } {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const enc = new TextEncoder();
  return {
    res: { status: 200, ok: true, json: () => Promise.resolve(null), body },
    write: (s) => ctrl?.enqueue(enc.encode(s)),
    end: () => ctrl?.close(),
  };
}

const tick = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let app: PhoneApp | null = null;
afterEach(() => {
  app?.stop();
  app = null;
  document.body.replaceChildren();
});

function setup(opts: {
  storage?: StorageLike | null;
  route: (url: string, init: RequestInit) => Promise<ResponseLike>;
}) {
  const root = document.createElement('div');
  document.body.append(root);
  const calls: Call[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, init });
    return opts.route(url, init);
  };
  app = new PhoneApp({
    doc: document,
    root,
    fetch: fetchFn,
    storage: opts.storage === undefined ? memoryStorage() : opts.storage,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => undefined,
    random: () => 0.5,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  });
  return { root, calls, timers, app };
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  const h = call?.init.headers as Record<string, string> | undefined;
  return h?.[name];
}

function bodyOf(call: Call | undefined): unknown {
  const body = call?.init.body;
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : null;
}

function input(root: HTMLElement, selector: string): HTMLInputElement {
  const el = root.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`no input ${selector}`);
  return el;
}

function submit(root: HTMLElement): void {
  const form = root.querySelector('form');
  if (!form) throw new Error('no form');
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

function fire(timers: { fn: () => void }[], i: number): void {
  const t = timers[i];
  if (!t) throw new Error(`no timer ${String(i)}`);
  t.fn();
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll('button')).find((x) => x.textContent === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

describe('phone page: pairing', () => {
  it('starts on pairing without a token, suggests a name, and checks the code before sending', async () => {
    const s = setup({ route: () => Promise.resolve(json(500, null)) });
    s.app.start();
    expect(s.root.querySelector('h2')?.textContent).toBe(W.pairTitle);
    expect(s.root.querySelector<HTMLInputElement>('#pair-name')?.value).toBe('iPhone');
    // The phone's number pad and the code from a message are offered.
    expect(input(s.root, '#pair-code').getAttribute('inputmode')).toBe('numeric');
    expect(input(s.root, '#pair-code').getAttribute('autocomplete')).toBe('one-time-code');
    expect(s.root.textContent).toContain(W.limits);
    input(s.root, '#pair-code').value = '12a';
    submit(s.root);
    await tick();
    expect(s.calls).toEqual([]);
    expect(s.root.querySelector('[role="alert"]')?.textContent).toBe(W.badCode);
  });

  it('pairs, stores the token, then opens the stream with the token in the header and never in the URL', async () => {
    const storage = memoryStorage();
    const live = stream();
    const s = setup({
      storage,
      route: (url) =>
        Promise.resolve(url === '/api/pair' ? json(200, { deviceId: 'd'.repeat(32), token: TOKEN }) : live.res),
    });
    s.app.start();
    input(s.root, '#pair-code').value = '123 456';
    input(s.root, '#pair-name').value = 'My phone';
    submit(s.root);
    await tick();
    expect(s.calls[0]?.url).toBe('/api/pair');
    expect(bodyOf(s.calls[0])).toEqual({ code: '123456', name: 'My phone' });
    expect(storage.data.get(TOKEN_KEY)).toBe(CREDS);
    // A fresh open is announced once (it counts as use for the 8-hour auto-off), then the stream opens.
    expect(s.calls[1]?.url).toBe('/api/state?open=1');
    expect(headerOf(s.calls[1], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(s.calls[2]?.url).toBe('/api/stream');
    expect(headerOf(s.calls[2], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    for (const c of s.calls) expect(c.url).not.toContain(TOKEN);
    live.write(`retry: 3000\n\nevent: view\ndata: ${JSON.stringify(VIEW)}\n\n`);
    await tick();
    expect(s.root.querySelector('.connection-word')?.textContent).toBe(W.live);
    expect(s.root.querySelector('.item-tool')?.textContent).toBe('Bash');
  });

  it('pairs without storage and says the browser will not remember it', async () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const live = stream();
    const s = setup({
      storage: throwing,
      route: (url) => Promise.resolve(url === '/api/pair' ? json(200, { deviceId: 'x', token: TOKEN }) : live.res),
    });
    s.app.start();
    input(s.root, '#pair-code').value = '123456';
    submit(s.root);
    await tick();
    expect(s.root.textContent).toContain(W.noStorage);
  });

  it('shows the refusal words for a wrong code and for too many tries', async () => {
    let status = 401;
    const s = setup({ route: () => Promise.resolve(json(status, { error: 'wrong or expired pairing code' })) });
    s.app.start();
    const tryCode = () => {
      input(s.root, '#pair-code').value = '000000';
      submit(s.root);
    };
    tryCode();
    await tick();
    expect(s.root.querySelector('[role="alert"]')?.textContent).toBe(W.pairRefused);
    status = 429;
    tryCode();
    await tick();
    expect(s.root.querySelector('[role="alert"]')?.textContent).toBe(W.tooMany);
  });
});

describe('phone page: main screen', () => {
  it('renders every agent and inbox string as text, approvals first, with Allow and Deny only on approvals', async () => {
    const live = stream();
    const s = setup({ storage: memoryStorage(CREDS), route: () => Promise.resolve(live.res) });
    s.app.start();
    await tick();
    live.write(`event: view\ndata: ${JSON.stringify(VIEW)}\n\n`);
    await tick();
    expect(s.root.querySelector('img')).toBeNull();
    expect(s.root.querySelector('.session-title')?.textContent).toBe(XSS);
    expect(s.root.querySelector('.item-summary')?.textContent).toBe(`rm -rf / ${XSS}`);
    const items = Array.from(s.root.querySelectorAll('.items > li'));
    expect(items.map((i) => i.classList.contains('approval'))).toEqual([true, false]);
    expect(items[1]?.querySelectorAll('button')).toHaveLength(0);
    expect(items[1]?.textContent).toContain('looks stuck');
    // Each item says which session it is in (a text node), unless the title would only repeat the agent's name.
    expect(items[1]?.querySelector('.item-session')?.textContent).toBe(XSS);
    expect(items[0]?.querySelector('.item-session')).toBeNull();
    // The limits sit at the foot, after the sessions.
    expect(s.root.querySelector('.page-foot .limits')?.textContent).toBe(W.limits);
    // Status as glyph and word: the session's own on its card, the subagent's on its row.
    expect(s.root.querySelector('.session-head .status')?.textContent).toBe('●working');
    // The session's requests are listed above: its card points there instead of repeating them.
    expect(s.root.querySelector('.session-need')?.textContent).toBe(
      `▲ ${W.needsApproval} · looks stuck · ${W.seeAbove}`,
    );
    expect(s.root.querySelector('.session .doing')).toBeNull();
    // Collapsed by default: no controls, no subagents until the summary is opened.
    expect(s.root.querySelector('.controls')).toBeNull();
    expect(s.root.querySelector('.agent')).toBeNull();
    s.root.querySelector<HTMLButtonElement>('.session-summary')?.click();
    const statuses = Array.from(s.root.querySelectorAll('.agent .status')).map((x) => x.textContent);
    expect(statuses).toEqual(['▲needs approval']);
    // The subagent has no estimate: no progress line at all, never a bare "—".
    expect(s.root.querySelector('.agent .progress')).toBeNull();
    expect(s.root.querySelector('.agent .agent-role')?.textContent).toBe('Explore');
    // Nothing listed above: the summary says progress and what it is doing now.
    live.write(`event: view\ndata: ${JSON.stringify({ ...VIEW, inbox: [] })}\n\n`);
    await tick();
    expect(s.root.querySelector('.session-need')).toBeNull();
    // The lead itself waits: its status already says "needs approval", so the line only points up.
    const [first] = VIEW.sessions;
    const [lead, ...rest] = first?.agents ?? [];
    const [approval] = VIEW.inbox;
    if (first === undefined || lead === undefined || approval === undefined) throw new Error('fixture');
    const leadWaits: PhoneView = {
      ...VIEW,
      sessions: [{ ...first, agents: [{ ...lead, status: 'waiting_approval' }, ...rest] }],
      inbox: [{ ...approval, agentKey: lead.key }],
    };
    live.write(`event: view\ndata: ${JSON.stringify(leadWaits)}\n\n`);
    await tick();
    expect(s.root.querySelector('.session-need')?.textContent).toBe(`▲ ${W.seeAbove}`);
    live.write(`event: view\ndata: ${JSON.stringify({ ...VIEW, inbox: [] })}\n\n`);
    await tick();
    expect(s.root.querySelector('.session-progress .progress-words')?.textContent).toBe('2 of 5 tasks · ~40% est.');
    expect(s.root.querySelector('.doing')?.textContent).toBe(`${W.doingNow} Bash: npm test ${XSS}`);
    expect(s.root.querySelector<HTMLElement>('.bar-fill')?.style.width).toBe('40%');
    expect(s.root.querySelector('img')).toBeNull();
  });

  it('allows with one press and denies only after the inline question', async () => {
    const live = stream();
    const s = setup({
      storage: memoryStorage(CREDS),
      route: (url) => Promise.resolve(url === '/api/decide' ? json(200, { ok: true }) : live.res),
    });
    s.app.start();
    await tick();
    live.write(`event: view\ndata: ${JSON.stringify(VIEW)}\n\n`);
    await tick();
    button(s.root, W.denyAsk).click();
    expect(s.root.querySelector('[role="group"] .confirm-text')?.textContent).toBe(W.denyConfirm);
    expect(s.calls.filter((c) => c.url === '/api/decide')).toHaveLength(0);
    button(s.root, W.back).click();
    expect(s.root.querySelector('[role="group"]')).toBeNull();
    button(s.root, W.denyAsk).click();
    button(s.root, W.deny).click();
    await tick();
    const decide = s.calls.filter((c) => c.url === '/api/decide');
    expect(decide).toHaveLength(1);
    expect(bodyOf(decide[0])).toEqual({ requestId: 'req-1', decision: 'deny' });
    expect(headerOf(decide[0], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(s.root.textContent).toContain(W.denySent);
    // Once the request leaves the view, its line goes too.
    live.write(`event: view\ndata: ${JSON.stringify({ ...VIEW, inbox: [] })}\n\n`);
    await tick();
    expect(s.root.textContent).toContain(W.inboxEmpty);
    expect(s.root.textContent).not.toContain(W.denySent);
  });

  it('says when a decision came too late', async () => {
    const live = stream();
    const s = setup({
      storage: memoryStorage(CREDS),
      route: (url) => Promise.resolve(url === '/api/decide' ? json(409, { error: 'x' }) : live.res),
    });
    s.app.start();
    await tick();
    live.write(`event: view\ndata: ${JSON.stringify(VIEW)}\n\n`);
    await tick();
    button(s.root, W.allow).click();
    await tick();
    expect(s.root.querySelector('[role="alert"]')?.textContent).toBe(W.decideGone);
    // It can be tried again.
    expect(button(s.root, W.allow)).toBeTruthy();
  });

  it('drops the token and shows pairing with a sentence on a 401 from the stream', async () => {
    const storage = memoryStorage(CREDS);
    const s = setup({ storage, route: () => Promise.resolve(json(401, { error: 'revoked' })) });
    s.app.start();
    await tick();
    expect(storage.data.has(TOKEN_KEY)).toBe(false);
    expect(s.root.querySelector('.note')?.textContent).toBe(W.signedOut);
    expect(s.root.querySelector('#pair-code')).not.toBeNull();
  });

  it('drops the token on a 401 from a decision', async () => {
    const storage = memoryStorage(CREDS);
    const live = stream();
    const s = setup({
      storage,
      route: (url) => Promise.resolve(url === '/api/decide' ? json(401, null) : live.res),
    });
    s.app.start();
    await tick();
    live.write(`event: view\ndata: ${JSON.stringify(VIEW)}\n\n`);
    await tick();
    button(s.root, W.allow).click();
    await tick();
    expect(storage.data.has(TOKEN_KEY)).toBe(false);
    expect(s.root.querySelector('.note')?.textContent).toBe(W.signedOut);
  });

  it('shows the view from /api/state?open=1 when nothing newer has arrived from the stream', async () => {
    const s = setup({
      storage: memoryStorage(CREDS),
      route: (url) =>
        url === '/api/state?open=1' ? Promise.resolve(json(200, VIEW)) : new Promise<Response>(() => undefined),
    });
    s.app.start();
    await tick();
    expect(s.root.querySelector('.item-tool')?.textContent).toBe('Bash');
  });

  it('falls back to /api/state when the stream fails, then reconnects with a growing delay', async () => {
    let streamOk = false;
    const live = stream();
    const s = setup({
      storage: memoryStorage(CREDS),
      route: (url) => {
        if (url === '/api/state') return Promise.resolve(json(200, VIEW));
        return streamOk ? Promise.resolve(live.res) : Promise.reject(new Error('offline'));
      },
    });
    s.app.start();
    await tick();
    // The open announcement fails too (offline); the fallback refresh is a plain /api/state, not an "open".
    expect(s.calls.map((c) => c.url)).toEqual(['/api/state?open=1', '/api/stream', '/api/state']);
    expect(headerOf(s.calls[2], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(s.root.querySelector('.connection-word')?.textContent).toBe(W.retrying);
    expect(s.root.querySelector('.item-tool')?.textContent).toBe('Bash');
    expect(s.timers.map((t) => t.ms)).toEqual([1000]);
    fire(s.timers, 0);
    await tick();
    expect(s.timers.map((t) => t.ms)).toEqual([1000, 2000]);
    streamOk = true;
    fire(s.timers, 1);
    await tick();
    expect(s.root.querySelector('.connection-word')?.textContent).toBe(W.live);
    // The stream ends (the server's max age): reconnect again, the delay back at the start.
    live.end();
    await tick();
    expect(s.root.querySelector('.connection-word')?.textContent).toBe(W.retrying);
    expect(s.timers.at(-1)?.ms).toBe(1000);
  });

  it('forgets the phone only after the inline question', async () => {
    const storage = memoryStorage(CREDS);
    const live = stream();
    const s = setup({ storage, route: () => Promise.resolve(live.res) });
    s.app.start();
    await tick();
    button(s.root, W.forgetAsk).click();
    expect(storage.data.has(TOKEN_KEY)).toBe(true);
    expect(s.root.querySelector('#forget-q')?.textContent).toBe(W.forgetConfirm);
    button(s.root, W.forget).click();
    expect(storage.data.has(TOKEN_KEY)).toBe(false);
    expect(s.root.querySelector('.note')?.textContent).toBe(W.forgotten);
  });
});

describe('phone view parsing', () => {
  it('keeps a good view and leaves out items of the wrong shape', () => {
    expect(parsePhoneView(JSON.parse(JSON.stringify(VIEW)))).toEqual(VIEW);
    const broken = {
      ...VIEW,
      extra: 'ignored',
      inbox: [{ kind: 'approval', id: 'x' }, { ...VIEW.inbox[1], kind: 'unknown_kind' }, VIEW.inbox[0]],
    };
    const parsed = parsePhoneView(broken);
    expect(parsed?.inbox).toEqual([VIEW.inbox[0]]);
    expect(parsed).not.toHaveProperty('extra');
  });

  it('refuses what is not a view', () => {
    for (const bad of [null, 'x', [], {}, { generatedAt: 'now', sessions: [], inbox: [] }]) {
      expect(parsePhoneView(bad)).toBeNull();
    }
  });
});

describe('phone page: answering, messaging, pause, resume and stop (ADR-030)', () => {
  const QUESTION: PhoneQuestionView = {
    kind: 'question',
    id: 'question:tu-q',
    requestId: 'tu-q',
    agentKey: 's1',
    agentName: 'main',
    title: 'Which color?',
    questions: [
      {
        question: `Which color? ${XSS}`,
        header: 'Color',
        multiSelect: false,
        options: [
          { label: XSS, description: 'warm' },
          { label: 'Blue', description: null },
        ],
      },
    ],
    answer: ON,
    createdAt: T,
    expiresAt: T + 60_000,
  };
  const MULTI: PhoneQuestionView = {
    ...QUESTION,
    questions: [
      {
        question: 'Which checks?',
        header: null,
        multiSelect: true,
        options: [
          { label: 'Lint', description: null },
          { label: 'Tests', description: null },
          { label: 'Types', description: null },
        ],
      },
    ],
  };
  const withQuestion = (q: PhoneQuestionView): PhoneView => ({ ...VIEW, inbox: [q] });
  const rootWith = (controls: Partial<PhoneView['sessions'][number]['agents'][number]['controls']>): PhoneView => {
    const [session] = VIEW.sessions;
    if (session === undefined) throw new Error('no session');
    const [root, ...rest] = session.agents;
    if (root === undefined) throw new Error('no root');
    return {
      ...VIEW,
      inbox: [],
      sessions: [{ ...session, agents: [{ ...root, controls: { ...root.controls, ...controls } }, ...rest] }],
    };
  };

  async function open(
    view: PhoneView,
    act: (body: unknown) => ResponseLike | Promise<ResponseLike> = () => json(200, { ok: true }),
  ) {
    const live = stream();
    const storage = memoryStorage(CREDS);
    const s = setup({
      storage,
      route: (url, init) =>
        Promise.resolve(
          url === '/api/act'
            ? act(typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null)
            : live.res,
        ),
    });
    s.app.start();
    await tick();
    const push = async (v: PhoneView) => {
      live.write(`event: view\ndata: ${JSON.stringify(v)}\n\n`);
      await tick();
    };
    await push(view);
    // Session cards start collapsed: open the first one so its controls show.
    s.root.querySelector<HTMLButtonElement>('.session-summary')?.click();
    const acts = () => s.calls.filter((c) => c.url === '/api/act');
    return { ...s, push, acts, storage };
  }

  function check(root: HTMLElement, id: string): void {
    const box = root.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`);
    if (!box) throw new Error(`no input ${id}`);
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  }

  function type(root: HTMLElement, selector: string, text: string): void {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!field) throw new Error(`no field ${selector}`);
    field.value = text;
    field.dispatchEvent(new Event('input'));
  }

  it('answers a single-choice question by option index; options are text; the line says it was sent', async () => {
    const s = await open(withQuestion(QUESTION));
    const card = s.root.querySelector('.item.question');
    expect(card?.querySelector('img')).toBeNull();
    expect(card?.querySelector('.question-words')?.textContent).toBe(`Which color? ${XSS}`);
    expect(Array.from(card?.querySelectorAll('.option-label') ?? []).map((x) => x.textContent)).toEqual([XSS, 'Blue']);
    expect(card?.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    // Nothing chosen: said on the card, nothing sent.
    button(s.root, W.questionSend).click();
    await tick();
    expect(s.acts()).toHaveLength(0);
    expect(s.root.querySelector('.question [role="alert"]')?.textContent).toBe(W.questionPick);
    // An option and typed words on a one-choice question: refused here too.
    check(s.root, 'opt-question:tu-q-0-1');
    type(s.root, '#other-question\\:tu-q-0', 'teal');
    button(s.root, W.questionSend).click();
    await tick();
    expect(s.acts()).toHaveLength(0);
    expect(s.root.querySelector('.question [role="alert"]')?.textContent).toBe(W.questionPickOne);
    type(s.root, '#other-question\\:tu-q-0', '');
    button(s.root, W.questionSend).click();
    await tick();
    expect(s.acts().map(bodyOf)).toEqual([{ type: 'question.answer', requestId: 'tu-q', answers: [{ choices: [1] }] }]);
    expect(headerOf(s.acts()[0], 'Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(s.root.querySelector('.question [role="status"]')?.textContent).toBe(W.answerSent);
    // Sent: the choices are gone; once the question leaves the view, so is its line.
    expect(s.root.querySelector('.question input')).toBeNull();
    await s.push({ ...VIEW, inbox: [] });
    expect(s.root.textContent).not.toContain(W.answerSent);
  });

  it('keeps choices and typed words through a live update, and sends several choices with typed words', async () => {
    const s = await open(withQuestion(MULTI));
    check(s.root, 'opt-question:tu-q-0-2');
    check(s.root, 'opt-question:tu-q-0-0');
    type(s.root, '#other-question\\:tu-q-0', 'e2e too');
    await s.push({ ...withQuestion(MULTI), generatedAt: T + 1 });
    expect(s.root.querySelector<HTMLInputElement>('#other-question\\:tu-q-0')?.value).toBe('e2e too');
    const checked = Array.from(s.root.querySelectorAll<HTMLInputElement>('.question input[type="checkbox"]')).map(
      (b) => b.checked,
    );
    expect(checked).toEqual([true, false, true]);
    button(s.root, W.questionSend).click();
    await tick();
    expect(bodyOf(s.acts()[0])).toEqual({
      type: 'question.answer',
      requestId: 'tu-q',
      answers: [{ choices: [0, 2], other: 'e2e too' }],
    });
  });

  it('shows why a question cannot be answered here, with no choices to make', async () => {
    const reason = 'Two choices or questions look the same here, so answer this one in the terminal.';
    const s = await open(withQuestion({ ...QUESTION, answer: off(reason) }));
    expect(s.root.querySelector('.question input')).toBeNull();
    expect(s.root.querySelector('.question .reason')?.textContent).toBe(reason);
    expect(Array.from(s.root.querySelectorAll('button')).some((b) => b.textContent === W.questionSend)).toBe(false);
  });

  it('messages the main agent at first chance: composer, Send, then the line says where it lands', async () => {
    const s = await open(rootWith({}));
    button(s.root, W.messageAsk).click();
    expect(s.root.querySelector('.composer')?.textContent).toContain(
      `${W.messageLands} after the next tool call or when this turn ends.`,
    );
    expect(s.root.querySelector<HTMLTextAreaElement>('textarea')?.maxLength).toBe(PHONE_TEXT_MAX);
    button(s.root, W.messageSend).click();
    await tick();
    expect(s.acts()).toHaveLength(0);
    expect(s.root.querySelector('.controls [role="alert"]')?.textContent).toBe(W.messageEmpty);
    type(s.root, 'textarea', 'use the small model');
    // A live update while typing keeps the draft.
    await s.push({ ...rootWith({}), generatedAt: T + 5 });
    expect(s.root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('use the small model');
    button(s.root, W.messageSend).click();
    await tick();
    expect(s.acts().map(bodyOf)).toEqual([{ type: 'agent.message', agentKey: 's1', text: 'use the small model' }]);
    expect(s.root.querySelector('textarea')).toBeNull();
    expect(s.root.querySelector('.controls [role="status"]')?.textContent).toBe(
      `${W.messageSent} ${W.messageLands} after the next tool call or when this turn ends.`,
    );
  });

  it('pauses with one press, shows Resume while paused, and resumes', async () => {
    const s = await open(rootWith({}));
    button(s.root, W.pause).click();
    await tick();
    expect(bodyOf(s.acts()[0])).toEqual({ type: 'agent.pause', agentKey: 's1' });
    expect(s.root.querySelector('.controls [role="status"]')?.textContent).toBe(W.pauseSent);
    await s.push(rootWith({ pause: off('Already paused.'), resume: ON }));
    button(s.root, W.resume).click();
    await tick();
    expect(bodyOf(s.acts()[1])).toEqual({ type: 'agent.resume', agentKey: 's1' });
  });

  it('stops only after the question inside the card; Back closes it without sending', async () => {
    const s = await open(rootWith({ stop: ON }));
    button(s.root, W.stopAsk).click();
    expect(s.root.querySelector('.controls [role="group"] .confirm-text')?.textContent).toBe(W.stopConfirm);
    expect(s.acts()).toHaveLength(0);
    button(s.root, W.back).click();
    expect(s.root.querySelector('.controls [role="group"]')).toBeNull();
    button(s.root, W.stopAsk).click();
    button(s.root, W.stop).click();
    await tick();
    expect(s.acts().map(bodyOf)).toEqual([{ type: 'agent.stop', agentKey: 's1' }]);
    expect(s.root.querySelector('.controls [role="status"]')?.textContent).toBe(W.stopSent);
  });

  it('disables Stop and its Yes while a command is sending, so a press is never silently dropped', async () => {
    let release: (r: ResponseLike) => void = () => undefined;
    const pending = new Promise<ResponseLike>((r) => {
      release = r;
    });
    const s = await open(rootWith({ stop: ON }), () => pending);
    button(s.root, W.pause).click();
    await tick();
    expect(button(s.root, W.stopAsk).disabled).toBe(true);
    release(json(200, { ok: true }));
    await tick();
    expect(button(s.root, W.stopAsk).disabled).toBe(false);
  });

  it('closes the Stop question and the composer when their control turns off', async () => {
    const s = await open(rootWith({ stop: ON }));
    button(s.root, W.stopAsk).click();
    expect(s.root.querySelector('.confirm')).not.toBeNull();
    await s.push(rootWith({ stop: off('This agent is no longer running.') }));
    expect(s.root.querySelector('.confirm')).toBeNull();
    // Back on later: it must not reappear by itself.
    await s.push(rootWith({ stop: ON }));
    expect(s.root.querySelector('.confirm')).toBeNull();
    button(s.root, W.messageAsk).click();
    expect(s.root.querySelector('.composer')).not.toBeNull();
    await s.push(rootWith({ message: off('This agent is no longer running.') }));
    expect(s.root.querySelector('.composer')).toBeNull();
    await s.push(rootWith({}));
    expect(s.root.querySelector('.composer')).toBeNull();
  });

  it('disables what the capabilities do not allow and says why in words, each reason once', async () => {
    const ended = 'This agent is no longer running.';
    const s = await open(rootWith({ message: off(ended), pause: off(ended), resume: off(ended), stop: off(ended) }));
    for (const text of [W.messageAsk, W.pause, W.stopAsk]) {
      const b = button(s.root, text);
      expect(b.disabled, text).toBe(true);
      expect(b.getAttribute('aria-describedby')).toBe('reasons-s1');
    }
    expect(Array.from(s.root.querySelectorAll('.controls .reason')).map((r) => r.textContent)).toEqual([
      `Message, Pause, Stop: ${ended}`,
    ]);
    // Stop off for any other reason keeps the reason next to the control, with Stop still shown.
    await s.push(rootWith({ stop: off(ended) }));
    expect(button(s.root, W.stopAsk).disabled).toBe(true);
    expect(Array.from(s.root.querySelectorAll('.controls .reason')).map((r) => r.textContent)).toEqual([
      `Stop: ${ended}`,
    ]);
    expect(s.root.querySelector('.sessions-note')).toBeNull();
    expect(button(s.root, W.pause).disabled).toBe(false);
  });

  it('hides Stop on a session started in a terminal and says so once under the list, not on each card', async () => {
    const [session] = VIEW.sessions;
    if (session === undefined) throw new Error('no session');
    const two: PhoneView = {
      ...rootWith({}),
      sessions: [
        ...rootWith({}).sessions,
        {
          ...session,
          rootKey: 's2',
          title: 'Second',
          agents: session.agents.slice(0, 1).map((a) => ({ ...a, key: 's2' })),
        },
      ],
    };
    const s = await open(two);
    // Open the second card too.
    s.root.querySelectorAll<HTMLButtonElement>('.session-summary')[1]?.click();
    expect(s.root.querySelectorAll('.controls')).toHaveLength(2);
    expect(Array.from(s.root.querySelectorAll('button')).some((b) => b.textContent === W.stopAsk)).toBe(false);
    expect(s.root.querySelectorAll('.controls .reason')).toHaveLength(0);
    expect(s.root.textContent).not.toContain(NO_STOP);
    const notes = Array.from(s.root.querySelectorAll('.sessions .sessions-note')).map((n) => n.textContent);
    expect(notes).toEqual([W.terminalStop]);
    // Even with every card collapsed the line is there, once, at the foot of the Agents section.
    for (const b of Array.from(s.root.querySelectorAll<HTMLButtonElement>('.session-summary'))) b.click();
    expect(s.root.querySelector('.controls')).toBeNull();
    expect(s.root.querySelector('.sessions')?.lastElementChild?.textContent).toBe(W.terminalStop);
    // A session Huddle launched: Stop is offered and there is no note.
    await s.push(rootWith({ stop: ON }));
    expect(s.root.querySelector('.sessions-note')).toBeNull();
  });

  it('starts every session collapsed, opens it with a real button, and keeps it open through live updates', async () => {
    const s = await open(rootWith({}));
    // open() pressed the summary once.
    const summary = () => {
      const b = s.root.querySelector<HTMLButtonElement>('.session-summary');
      if (!b) throw new Error('no summary');
      return b;
    };
    expect(summary().type).toBe('button');
    expect(summary().closest('h3')).not.toBeNull();
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(summary().getAttribute('aria-controls')).toBe('session-body-s1');
    expect(s.root.querySelector('#session-body-s1 .controls')).not.toBeNull();
    // A new view (new progress, new activity) does not collapse it, and focus stays on the summary.
    summary().focus();
    await s.push({ ...rootWith({}), generatedAt: T + 9 });
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(summary());
    expect(s.root.querySelector('.controls')).not.toBeNull();
    // Closing it hides the controls and closes an open message box with them.
    button(s.root, W.messageAsk).click();
    summary().click();
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(summary().hasAttribute('aria-controls')).toBe(false);
    expect(s.root.querySelector('.controls')).toBeNull();
    summary().click();
    expect(s.root.querySelector('.composer')).toBeNull();
    // A session that leaves the view forgets it was open.
    await s.push({ ...rootWith({}), sessions: [] });
    await s.push(rootWith({}));
    expect(summary().getAttribute('aria-expanded')).toBe('false');
  });

  it('leaves out empty lines: no bare "—" progress and no "nothing running" sentence', async () => {
    const [session] = VIEW.sessions;
    const root = session?.agents[0];
    if (session === undefined || root === undefined) throw new Error('no session');
    const idle: PhoneView = {
      ...VIEW,
      inbox: [],
      sessions: [
        {
          ...session,
          agents: [{ ...root, status: 'idle', progress: { fraction: null, label: null }, activity: null }],
        },
      ],
    };
    const s = await open(idle);
    expect(s.root.querySelector('.progress')).toBeNull();
    expect(s.root.querySelector('.doing')).toBeNull();
    expect(s.root.querySelector('.session-progress')).toBeNull();
    const text = s.root.querySelector('.sessions')?.textContent ?? '';
    expect(text).not.toContain('—');
    expect(text).not.toMatch(/nothing running/i);
  });

  it("shows the Huddle's refusal as text, and a 401 from an action signs the phone out", async () => {
    let status = 403;
    const s = await open(rootWith({}), () => json(status, { error: `Pausing at the next tool call. ${XSS}` }));
    button(s.root, W.pause).click();
    await tick();
    expect(s.root.querySelector('.controls [role="alert"]')?.textContent).toBe(`Pausing at the next tool call. ${XSS}`);
    expect(s.root.querySelector('img')).toBeNull();
    status = 401;
    button(s.root, W.pause).click();
    await tick();
    expect(s.storage.data.has(TOKEN_KEY)).toBe(false);
    expect(s.root.querySelector('.note')?.textContent).toBe(W.signedOut);
  });

  it('parses questions and controls, and refuses a question whose options are broken (indexes would shift)', () => {
    const view = withQuestion(QUESTION);
    expect(parsePhoneView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    const broken = {
      ...view,
      inbox: [{ ...QUESTION, questions: [{ ...QUESTION.questions[0], options: [{ label: 1 }, { label: 'B' }] }] }],
    };
    expect(parsePhoneView(broken)?.inbox).toEqual([]);
    // A control of an unknown shape is never offered.
    const [session] = VIEW.sessions;
    const weird = {
      ...VIEW,
      sessions: [{ ...session, agents: [{ ...session?.agents[0], controls: { pause: 'yes' } }] }],
    };
    expect(parsePhoneView(weird)?.sessions[0]?.agents[0]?.controls.pause.enabled).toBe(false);
  });
});

describe('phone page: an approval whose command is partly hidden (AX-01)', () => {
  const hiddenView = (approval: Record<string, unknown>): unknown => ({ ...VIEW, inbox: [approval, VIEW.inbox[1]] });

  it('shows the note and Deny, with no Allow button', async () => {
    const live = stream();
    const s = setup({ storage: memoryStorage(CREDS), route: () => Promise.resolve(live.res) });
    s.app.start();
    await tick();
    live.write(`event: view\ndata: ${JSON.stringify(hiddenView({ ...VIEW.inbox[0], hidden: true }))}\n\n`);
    await tick();
    const card = s.root.querySelector('.items > li.approval');
    expect(card?.querySelector('.item-hidden')?.textContent).toBe(W.hiddenNote);
    const labels = Array.from(card?.querySelectorAll('button') ?? []).map((b) => b.textContent);
    expect(labels).not.toContain(W.allow);
    expect(labels).toContain(W.denyAsk);
  });

  it('treats an approval without the flag as hidden', () => {
    const { hidden: _drop, ...old } = VIEW.inbox[0] as unknown as Record<string, unknown>;
    const parsed = parsePhoneView(hiddenView(old));
    const first = parsed?.inbox[0];
    expect(first?.kind === 'approval' && first.hidden).toBe(true);
  });
});
