/**
 * The phone page's controller (M6, F26): pairing, the live stream, Allow and Deny, forgetting, and signing out on 401.
 *
 *  - The device token lives in `localStorage` (every access wrapped: private browsing throws) and only ever goes in the
 *    `Authorization` header, never in a URL. That is why the stream is read with `fetch` and parsed here (sse.ts):
 *    `EventSource` cannot send headers.
 *  - Live updates: `GET /api/stream`. When it fails or ends, `GET /api/state` once (so the screen is not empty), then
 *    reconnect with a growing, jittered delay (1 s doubling to 30 s). A stream that sends nothing for longer than three
 *    heartbeats is treated as dead. Coming back to the page reconnects at once.
 *  - Any 401 means the token no longer works (revoked, or Huddle forgot it): the token is dropped and the pairing
 *    screen says why.
 *  - The page can only decide approvals the view lists, and (ADR-030) answer the questions it lists and message, pause,
 *    resume or stop the agents it lists, each only when the view's control is enabled; the server checks all of it again
 *    (`POST /api/act`, an explicit allowlist). Stop asks once more inside the card. Drafts (choices, typed words) and which
 *    session cards are open live here, so a live update that redraws the screen keeps them.
 *
 * Everything with a side effect is passed in (`PhoneDeps`), so tests drive it with a fake fetch, storage and clock.
 */
import { PHONE_TEXT_MAX, type PhoneAction, type PhoneView } from '@huddle/shared';
import { createSseParser } from './sse.js';
import { errorOf, parsePairAnswer, parsePhoneView } from './view-data.js';
import { guessDeviceName, PHONE_WORDS as W } from './words.js';
import {
  agentActKey,
  answerKey,
  renderMain,
  renderPairing,
  type ActState,
  type AgentControlName,
  type AnswerDraft,
  type Connection,
  type DecisionState,
  type PairUi,
} from './render.js';

/** What the page needs of a fetch Response (a real one, or a test double). */
export interface ResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PhoneDeps {
  doc: Document;
  root: HTMLElement;
  fetch: FetchLike;
  /** null when the browser has no storage at all. */
  storage: StorageLike | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  random: () => number;
  userAgent: string;
}

export const TOKEN_KEY = 'agent-huddle.phone';
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** Three heartbeats (the server sends one every 20 s) plus slack. */
export const STREAM_SILENCE_MS = 65_000;

interface Credentials {
  deviceId: string;
  token: string;
}

type Screen = { kind: 'pairing'; ui: PairUi } | { kind: 'main' };

export class PhoneApp {
  private readonly deps: PhoneDeps;
  private creds: Credentials | null = null;
  private screen: Screen;
  private view: PhoneView | null = null;
  private connection: Connection = 'connecting';
  private decisions: Record<string, DecisionState> = {};
  private confirmDeny: string | null = null;
  private confirmForget = false;
  private note: string | null = null;
  private actions: Record<string, ActState> = {};
  private answerDrafts: Record<string, AnswerDraft> = {};
  private composer: string | null = null;
  private messageDrafts: Record<string, string> = {};
  private confirmStop: string | null = null;
  private expanded: Record<string, boolean> = {};
  private generation = 0;
  private attempts = 0;
  private abort: AbortController | null = null;
  private retryTimer: unknown = null;
  private silenceTimer: unknown = null;

  constructor(deps: PhoneDeps) {
    this.deps = deps;
    this.screen = { kind: 'pairing', ui: this.freshPairUi(null) };
  }

  /** Shows the main screen when this phone holds a token, else the pairing screen. */
  start(): void {
    this.creds = this.loadCreds();
    if (this.creds === null) this.showPairing(null);
    else this.showMain();
  }

  /** The page became visible again: reconnect now if the stream is not live. */
  wake(): void {
    if (this.screen.kind === 'main' && this.connection !== 'live') this.connect();
  }

  /** Stops every timer and the stream (tests; the page never needs it). */
  stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.clearTimers();
  }

  private onScreen(kind: Screen['kind']): boolean {
    return this.screen.kind === kind;
  }

  // --- pairing -------------------------------------------------------------------------------------------------------

  private freshPairUi(notice: string | null): PairUi {
    return { notice, error: null, busy: false, code: '', name: guessDeviceName(this.deps.userAgent) };
  }

  private showPairing(notice: string | null): void {
    this.stop();
    this.view = null;
    this.decisions = {};
    this.confirmDeny = null;
    this.confirmForget = false;
    this.actions = {};
    this.answerDrafts = {};
    this.composer = null;
    this.messageDrafts = {};
    this.confirmStop = null;
    this.expanded = {};
    this.screen = { kind: 'pairing', ui: this.freshPairUi(notice) };
    this.render();
  }

  private async pair(rawCode: string, rawName: string): Promise<void> {
    if (this.screen.kind !== 'pairing') return;
    const code = rawCode.replace(/\s+/g, '');
    const name = rawName.trim() === '' ? guessDeviceName(this.deps.userAgent) : rawName.trim().slice(0, 60);
    const ui: PairUi = { ...this.screen.ui, code, name, error: null, busy: true };
    if (!/^[0-9]{6}$/.test(code)) {
      this.screen = { kind: 'pairing', ui: { ...ui, busy: false, error: W.badCode } };
      this.render();
      return;
    }
    this.screen = { kind: 'pairing', ui };
    this.render();
    let error: string;
    try {
      const res = await this.deps.fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name }),
        cache: 'no-store',
        credentials: 'omit',
      });
      const body = await safeJson(res);
      if (res.ok) {
        const answer = parsePairAnswer(body);
        if (answer !== null) {
          this.creds = answer;
          this.note = this.saveCreds(answer) ? null : W.noStorage;
          this.showMain();
          return;
        }
        error = W.pairBroken;
      } else if (res.status === 429) error = W.tooMany;
      else if (res.status === 400 || res.status === 401) error = W.pairRefused;
      else error = errorOf(body) ?? W.pairRefused;
    } catch {
      error = W.unreachable;
    }
    // The screen may have changed while the request was out (it never does today; cheap to check).
    if (!this.onScreen('pairing')) return;
    this.screen = { kind: 'pairing', ui: { ...ui, busy: false, error } };
    this.render();
  }

  // --- credentials ---------------------------------------------------------------------------------------------------

  private loadCreds(): Credentials | null {
    try {
      const raw = this.deps.storage?.getItem(TOKEN_KEY) ?? null;
      return raw === null ? null : parsePairAnswer(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  private saveCreds(c: Credentials): boolean {
    try {
      if (this.deps.storage === null) return false;
      this.deps.storage.setItem(TOKEN_KEY, JSON.stringify(c));
      return true;
    } catch {
      return false;
    }
  }

  private dropCreds(): void {
    this.creds = null;
    try {
      this.deps.storage?.removeItem(TOKEN_KEY);
    } catch {
      // Nothing to do: the token is gone from memory, which is what this page uses.
    }
  }

  /** A 401: the token stopped working. */
  private signedOut(): void {
    this.dropCreds();
    this.showPairing(W.signedOut);
  }

  private forget(): void {
    this.dropCreds();
    this.showPairing(W.forgotten);
  }

  private authHeaders(): Record<string, string> {
    return this.creds === null ? {} : { Authorization: `Bearer ${this.creds.token}` };
  }

  // --- main screen and the stream ------------------------------------------------------------------------------------

  private showMain(): void {
    this.screen = { kind: 'main' };
    this.connection = 'connecting';
    this.render();
    // The fetch starts first (the open must reach the server before the stream does); connect() then moves the
    // generation on, so the reply is judged against the generation that is current after it.
    const opened = this.fetchOpenView();
    this.connect();
    const gen = this.generation;
    void opened.then((view) => {
      // The stream may have shown a newer view while this reply was read; never replace it with this one.
      if (view !== null && gen === this.generation && !this.hasView()) this.setView(view);
    });
  }

  /**
   * A fresh open of the page: `GET /api/state?open=1` once. It is the only read that counts as use for the 8-hour
   * auto-off (with every action the core carries out: Allow, Deny and the ADR-030 actions); stream reconnects and
   * the fallback refresh do not (owner, 2026-11-16). The view it returns is shown if nothing newer has arrived;
   * failures are left to the stream's own handling.
   */
  private async fetchOpenView(): Promise<PhoneView | null> {
    try {
      const res = await this.deps.fetch('/api/state?open=1', {
        method: 'GET',
        headers: this.authHeaders(),
        cache: 'no-store',
        credentials: 'omit',
      });
      return res.ok ? parsePhoneView(await safeJson(res)) : null;
    } catch {
      // Not reachable now; the stream reports it.
      return null;
    }
  }

  /** Read at call time (after an await), so a view the stream set meanwhile is seen. */
  private hasView(): boolean {
    return this.view !== null;
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    if (this.silenceTimer !== null) this.deps.clearTimeout(this.silenceTimer);
    this.retryTimer = null;
    this.silenceTimer = null;
  }

  private setConnection(c: Connection): void {
    if (this.connection === c) return;
    this.connection = c;
    this.render();
  }

  private nextDelay(): number {
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempts);
    this.attempts += 1;
    return Math.round(base * (0.75 + this.deps.random() * 0.5));
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation) return;
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation) this.connect();
    }, this.nextDelay());
  }

  private armSilence(gen: number, ac: AbortController): void {
    if (this.silenceTimer !== null) this.deps.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.deps.setTimeout(() => {
      this.silenceTimer = null;
      if (gen === this.generation) ac.abort();
    }, STREAM_SILENCE_MS);
  }

  /** Opens the live stream (a new generation: any older loop stops at its next step). */
  private connect(): void {
    if (this.creds === null) return;
    this.generation += 1;
    const gen = this.generation;
    this.abort?.abort();
    this.clearTimers();
    const ac = new AbortController();
    this.abort = ac;
    void this.runStream(gen, ac);
  }

  private async runStream(gen: number, ac: AbortController): Promise<void> {
    let res: ResponseLike;
    try {
      res = await this.deps.fetch('/api/stream', {
        method: 'GET',
        headers: { ...this.authHeaders(), Accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'omit',
        signal: ac.signal,
      });
    } catch {
      if (gen === this.generation) await this.fallback(gen);
      return;
    }
    if (gen !== this.generation) return;
    if (res.status === 401) {
      this.signedOut();
      return;
    }
    if (!res.ok || res.body === null) {
      await this.fallback(gen);
      return;
    }
    this.attempts = 0;
    this.setConnection('live');
    this.armSilence(gen, ac);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (gen !== this.generation) {
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (done) break;
        this.armSilence(gen, ac);
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (ev.event !== 'view') continue;
          let data: unknown;
          try {
            data = JSON.parse(ev.data) as unknown;
          } catch {
            continue;
          }
          const view = parsePhoneView(data);
          if (view !== null) this.setView(view);
        }
      }
    } catch {
      // The stream broke (network, or the silence timer aborted it): reconnect below.
    }
    if (gen !== this.generation) return;
    if (this.silenceTimer !== null) this.deps.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.setConnection('retrying');
    this.scheduleReconnect(gen);
  }

  /** The stream could not open: show the latest view once if Huddle answers, then try the stream again later. */
  private async fallback(gen: number): Promise<void> {
    this.setConnection(this.view === null ? 'connecting' : 'retrying');
    try {
      const res = await this.deps.fetch('/api/state', {
        method: 'GET',
        headers: this.authHeaders(),
        cache: 'no-store',
        credentials: 'omit',
      });
      if (gen !== this.generation) return;
      if (res.status === 401) {
        this.signedOut();
        return;
      }
      if (res.ok) {
        const view = parsePhoneView(await safeJson(res));
        if (view !== null && gen === this.generation) this.setView(view);
      }
    } catch {
      // Not reachable now; the reconnect below tries again.
    }
    if (gen !== this.generation) return;
    this.setConnection('retrying');
    this.scheduleReconnect(gen);
  }

  private setView(view: PhoneView): void {
    this.view = view;
    const open = new Set(view.inbox.flatMap((i) => (i.kind === 'approval' ? [i.requestId] : [])));
    // A decision line stays while its request is still listed; once it is gone, so is the line.
    this.decisions = Object.fromEntries(Object.entries(this.decisions).filter(([id]) => open.has(id)));
    if (this.confirmDeny !== null && !open.has(this.confirmDeny)) this.confirmDeny = null;
    // Questions: a draft and its line stay while the question is listed. Agents: while the agent is listed.
    const questions = new Set(view.inbox.flatMap((i) => (i.kind === 'question' ? [i.requestId] : [])));
    const agents = new Set(view.sessions.flatMap((s) => s.agents.map((a) => a.key)));
    const keep = new Set([...[...questions].map(answerKey), ...[...agents].map(agentActKey)]);
    this.actions = Object.fromEntries(Object.entries(this.actions).filter(([k]) => keep.has(k)));
    this.answerDrafts = Object.fromEntries(Object.entries(this.answerDrafts).filter(([id]) => questions.has(id)));
    this.messageDrafts = Object.fromEntries(Object.entries(this.messageDrafts).filter(([k]) => agents.has(k)));
    // The composer and the Stop question close when their control turns off (agent ended, control disabled) or the agent is gone.
    const controls = new Map(view.sessions.flatMap((s) => s.agents.map((a) => [a.key, a.controls] as const)));
    if (this.composer !== null && controls.get(this.composer)?.message.enabled !== true) this.composer = null;
    if (this.confirmStop !== null && controls.get(this.confirmStop)?.stop.enabled !== true) this.confirmStop = null;
    // An opened card stays open while its session is listed.
    const roots = new Set(view.sessions.map((s) => s.rootKey));
    this.expanded = Object.fromEntries(Object.entries(this.expanded).filter(([k]) => roots.has(k)));
    this.render();
  }

  // --- actions (ADR-030) ---------------------------------------------------------------------------------------------

  private setAct(key: string, state: ActState): void {
    this.actions = { ...this.actions, [key]: state };
  }

  /** POST /api/act. Answers the line to show under the control. */
  private async act(key: string, action: PhoneAction, sent: string): Promise<boolean> {
    const current = this.actions[key];
    if (current?.state === 'sending') return false;
    this.setAct(key, { state: 'sending' });
    this.render();
    let next: ActState;
    try {
      const res = await this.deps.fetch('/api/act', {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
        cache: 'no-store',
        credentials: 'omit',
      });
      if (res.status === 401) {
        this.signedOut();
        return false;
      }
      if (res.ok) next = { state: 'sent', message: sent };
      else if (res.status === 404 || res.status === 409) next = { state: 'error', message: W.actGone };
      else if (res.status === 503 || res.status === 429) next = { state: 'error', message: W.decideBusy };
      else next = { state: 'error', message: errorOf(await safeJson(res)) ?? W.actRefused };
    } catch {
      next = { state: 'error', message: W.decideUnreachable };
    }
    if (!this.onScreen('main')) return false;
    this.setAct(key, next);
    this.render();
    return next.state === 'sent';
  }

  private draftOf(requestId: string): AnswerDraft {
    const q = this.view?.inbox.find((i) => i.kind === 'question' && i.requestId === requestId);
    const n = q?.kind === 'question' ? q.questions.length : 0;
    const d = this.answerDrafts[requestId];
    return {
      choices: Array.from({ length: n }, (_, i) => [...(d?.choices[i] ?? [])]),
      other: Array.from({ length: n }, (_, i) => d?.other[i] ?? ''),
    };
  }

  private choose(requestId: string, qi: number, oi: number, on: boolean, single: boolean): void {
    const d = this.draftOf(requestId);
    const list = d.choices[qi];
    if (list === undefined) return;
    d.choices[qi] = single ? (on ? [oi] : []) : on ? [...new Set([...list, oi])] : list.filter((x) => x !== oi);
    this.answerDrafts = { ...this.answerDrafts, [requestId]: d };
  }

  private typeOther(requestId: string, qi: number, text: string): void {
    const d = this.draftOf(requestId);
    if (qi >= d.other.length) return;
    d.other[qi] = text.slice(0, PHONE_TEXT_MAX);
    this.answerDrafts = { ...this.answerDrafts, [requestId]: d };
  }

  private async answer(requestId: string): Promise<void> {
    const q = this.view?.inbox.find((i) => i.kind === 'question' && i.requestId === requestId);
    if (q?.kind !== 'question' || !q.answer.enabled) return;
    const d = this.draftOf(requestId);
    const key = answerKey(requestId);
    for (const [qi, part] of q.questions.entries()) {
      const chosen = d.choices[qi] ?? [];
      const typed = (d.other[qi] ?? '').trim();
      const problem =
        chosen.length === 0 && typed === ''
          ? W.questionPick
          : !part.multiSelect && chosen.length > 0 && typed !== ''
            ? W.questionPickOne
            : null;
      if (problem !== null) {
        this.setAct(key, { state: 'error', message: problem });
        this.render();
        return;
      }
    }
    const answers = q.questions.map((_, qi) => {
      const typed = (d.other[qi] ?? '').trim();
      return { choices: [...(d.choices[qi] ?? [])].sort((a, b) => a - b), ...(typed !== '' ? { other: typed } : {}) };
    });
    await this.act(key, { type: 'question.answer', requestId, answers }, W.answerSent);
  }

  private async sendMessage(agentKey: string): Promise<void> {
    const text = (this.messageDrafts[agentKey] ?? '').trim();
    const key = agentActKey(agentKey);
    if (text === '') {
      this.setAct(key, { state: 'error', message: W.messageEmpty });
      this.render();
      return;
    }
    const agent = this.view?.sessions.flatMap((s) => s.agents).find((a) => a.key === agentKey);
    const sent =
      agent?.messageLands != null ? `${W.messageSent} ${W.messageLands} ${agent.messageLands}.` : W.messageSent;
    if (await this.act(key, { type: 'agent.message', agentKey, text: text.slice(0, PHONE_TEXT_MAX) }, sent)) {
      this.messageDrafts = Object.fromEntries(Object.entries(this.messageDrafts).filter(([k]) => k !== agentKey));
      this.composer = null;
      this.render();
    }
  }

  private async control(agentKey: string, name: AgentControlName): Promise<void> {
    await this.act(
      agentActKey(agentKey),
      { type: name === 'pause' ? 'agent.pause' : 'agent.resume', agentKey },
      name === 'pause' ? W.pauseSent : W.resumeSent,
    );
  }

  private async stopAgent(agentKey: string): Promise<void> {
    // A command is already on its way: keep the question open (its Yes is disabled) rather than drop the press.
    if (this.actions[agentActKey(agentKey)]?.state === 'sending') return;
    this.confirmStop = null;
    await this.act(agentActKey(agentKey), { type: 'agent.stop', agentKey }, W.stopSent);
  }

  private async decide(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const current = this.decisions[requestId];
    if (current !== undefined && current.state !== 'error') return;
    this.decisions = { ...this.decisions, [requestId]: { state: 'sending', decision } };
    this.confirmDeny = null;
    this.render();
    let next: DecisionState;
    try {
      const res = await this.deps.fetch('/api/decide', {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, decision }),
        cache: 'no-store',
        credentials: 'omit',
      });
      if (res.status === 401) {
        this.signedOut();
        return;
      }
      if (res.ok) next = { state: 'sent', decision };
      else if (res.status === 404 || res.status === 409) next = { state: 'error', message: W.decideGone };
      else if (res.status === 503 || res.status === 429) next = { state: 'error', message: W.decideBusy };
      else next = { state: 'error', message: errorOf(await safeJson(res)) ?? W.decideBusy };
    } catch {
      next = { state: 'error', message: W.decideUnreachable };
    }
    if (!this.onScreen('main')) return;
    this.decisions = { ...this.decisions, [requestId]: next };
    this.render();
  }

  // --- rendering -----------------------------------------------------------------------------------------------------

  /** Redraws the screen and puts focus back on the control that had it (matched by its data-focus key). */
  private render(): void {
    const { doc, root } = this.deps;
    const active = doc.activeElement;
    const focusKey = active instanceof HTMLElement ? (active.dataset['focus'] ?? null) : null;
    // A live update while typing: put the caret back where it was.
    const caret =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? { start: active.selectionStart, end: active.selectionEnd }
        : null;
    const node =
      this.screen.kind === 'pairing'
        ? renderPairing(doc, this.screen.ui, {
            pair: (code, name) => {
              void this.pair(code, name);
            },
          })
        : renderMain(
            doc,
            {
              view: this.view,
              connection: this.connection,
              decisions: this.decisions,
              confirmDeny: this.confirmDeny,
              confirmForget: this.confirmForget,
              note: this.note,
              actions: this.actions,
              answerDrafts: this.answerDrafts,
              composer: this.composer,
              messageDrafts: this.messageDrafts,
              confirmStop: this.confirmStop,
              expanded: this.expanded,
            },
            {
              decide: (requestId, decision) => {
                void this.decide(requestId, decision);
              },
              askDeny: (requestId) => {
                const previous = this.confirmDeny;
                this.confirmDeny = requestId;
                this.render();
                // Into the question when it opens; back to "Deny…" when it closes.
                const target =
                  requestId !== null ? `deny-yes:${requestId}` : previous !== null ? `deny:${previous}` : null;
                if (target !== null) focusByKey(root, target);
              },
              askForget: (open) => {
                this.confirmForget = open;
                this.render();
                focusByKey(root, open ? 'forget-yes' : 'forget');
              },
              forget: () => {
                this.forget();
              },
              choose: (requestId, qi, oi, on, single) => {
                this.choose(requestId, qi, oi, on, single);
                this.render();
              },
              typeOther: (requestId, qi, text) => {
                this.typeOther(requestId, qi, text);
              },
              answer: (requestId) => {
                void this.answer(requestId);
              },
              openComposer: (agentKey) => {
                const previous = this.composer;
                this.composer = agentKey;
                this.confirmStop = null;
                this.render();
                const target =
                  agentKey !== null ? `msg:${agentKey}` : previous !== null ? `msg-open:${previous}` : null;
                if (target !== null) focusByKey(root, target);
              },
              typeMessage: (agentKey, text) => {
                this.messageDrafts = { ...this.messageDrafts, [agentKey]: text.slice(0, PHONE_TEXT_MAX) };
              },
              sendMessage: (agentKey) => {
                void this.sendMessage(agentKey);
              },
              control: (agentKey, name) => {
                void this.control(agentKey, name);
              },
              askStop: (agentKey) => {
                const previous = this.confirmStop;
                this.confirmStop = agentKey;
                this.composer = null;
                this.render();
                const target =
                  agentKey !== null ? `stop-yes:${agentKey}` : previous !== null ? `stop:${previous}` : null;
                if (target !== null) focusByKey(root, target);
              },
              stop: (agentKey) => {
                void this.stopAgent(agentKey);
              },
              toggleSession: (rootKey) => {
                const open = this.expanded[rootKey] !== true;
                this.expanded = open
                  ? { ...this.expanded, [rootKey]: true }
                  : Object.fromEntries(Object.entries(this.expanded).filter(([k]) => k !== rootKey));
                if (!open) {
                  // Closing the card closes its message box and its Stop question too (their controls are hidden).
                  const keys = new Set(
                    this.view?.sessions.find((s) => s.rootKey === rootKey)?.agents.map((a) => a.key),
                  );
                  if (this.composer !== null && keys.has(this.composer)) this.composer = null;
                  if (this.confirmStop !== null && keys.has(this.confirmStop)) this.confirmStop = null;
                }
                this.render();
              },
            },
          );
    root.replaceChildren(node);
    if (focusKey !== null) focusByKey(root, focusKey);
    const now = doc.activeElement;
    if (caret !== null && (now instanceof HTMLInputElement || now instanceof HTMLTextAreaElement)) {
      try {
        now.setSelectionRange(caret.start, caret.end);
      } catch {
        // Radio buttons and checkboxes have no caret.
      }
    }
  }
}

function focusByKey(root: HTMLElement, key: string): void {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-focus]'))) {
    if (node.dataset['focus'] === key) {
      node.focus();
      return;
    }
  }
}

async function safeJson(res: ResponseLike): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
