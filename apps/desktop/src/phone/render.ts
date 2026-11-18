/**
 * The phone page's screens (M6, F26), built with `createElement` and `textContent` only: every name, role, title and
 * summary came from an agent or a hook, so none of it is ever parsed as markup (no `innerHTML` anywhere on the page).
 * No inline styles either (the page's CSP has no 'unsafe-inline'): a progress bar's width is set through the CSSOM,
 * which CSP allows. Builders take the `Document` so tests can run them in happy-dom.
 *
 * ADR-030: each session is one compact card (its main agent's status as glyph and word, the estimated progress, what
 * it is doing now). Opened, it shows the controls its capabilities allow, each disabled one with its reason in words
 * (except Stop on a session started in a terminal, said once under the list), and its subagents as short rows. Held
 * questions are answered in place. Stop asks once more inside the card (no dialogs).
 */
import {
  PHONE_TEXT_MAX,
  RUN_REASONS,
  type PhoneAgentView,
  type PhoneApprovalView,
  type PhoneControl,
  type PhoneInboxItem,
  type PhoneQuestionView,
  type PhoneSessionView,
  type PhoneView,
} from '@huddle/shared';
import { clock, noticeWords, PHONE_WORDS as W, progressWords, statusLook } from './words.js';

export type Connection = 'connecting' | 'live' | 'retrying';

export type DecisionState =
  | { state: 'sending'; decision: 'allow' | 'deny' }
  | { state: 'sent'; decision: 'allow' | 'deny' }
  | { state: 'error'; message: string };

/** The last action sent for one question (`answer:<requestId>`) or one agent (`agent:<key>`). */
export type ActState = { state: 'sending' } | { state: 'sent'; message: string } | { state: 'error'; message: string };

/** What the user has picked or typed for a held question, per question index. */
export interface AnswerDraft {
  choices: number[][];
  other: string[];
}

export type AgentControlName = 'pause' | 'resume';

export interface MainUi {
  view: PhoneView | null;
  connection: Connection;
  decisions: Readonly<Record<string, DecisionState>>;
  /** The approval whose Deny is being confirmed. */
  confirmDeny: string | null;
  confirmForget: boolean;
  /** A sentence under the header (storage unavailable), or null. */
  note: string | null;
  actions: Readonly<Record<string, ActState>>;
  answerDrafts: Readonly<Record<string, AnswerDraft>>;
  /** The agent whose message box is open. */
  composer: string | null;
  messageDrafts: Readonly<Record<string, string>>;
  /** The agent whose Stop is being confirmed. */
  confirmStop: string | null;
  /** Session cards the user opened, by rootKey (collapsed by default). */
  expanded: Readonly<Record<string, boolean>>;
}

export interface MainHandlers {
  decide(requestId: string, decision: 'allow' | 'deny'): void;
  askDeny(requestId: string | null): void;
  askForget(open: boolean): void;
  forget(): void;
  /** A choice was ticked or unticked (`single`: a radio, which replaces the others). */
  choose(requestId: string, question: number, option: number, on: boolean, single: boolean): void;
  /** Typed into a question's own answer box (no redraw: the draft is kept for the next one). */
  typeOther(requestId: string, question: number, text: string): void;
  answer(requestId: string): void;
  openComposer(agentKey: string | null): void;
  typeMessage(agentKey: string, text: string): void;
  sendMessage(agentKey: string): void;
  control(agentKey: string, name: AgentControlName): void;
  askStop(agentKey: string | null): void;
  stop(agentKey: string): void;
  /** Opens or closes one session card. */
  toggleSession(rootKey: string): void;
}

export interface PairUi {
  /** Why the pairing screen shows (signed out, forgotten), or null on first visit. */
  notice: string | null;
  error: string | null;
  busy: boolean;
  code: string;
  name: string;
}

export interface PairHandlers {
  pair(code: string, name: string): void;
}

/** The action-state key of a question or an agent. */
export const answerKey = (requestId: string): string => `answer:${requestId}`;
export const agentActKey = (agentKey: string): string => `agent:${agentKey}`;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc: Document, text: string, className: string, focusKey: string, onClick: () => void) {
  const b = el(doc, 'button', className, text);
  b.type = 'button';
  b.dataset['focus'] = focusKey;
  b.addEventListener('click', onClick);
  return b;
}

/** Glyph and word: the glyph is decorative, the word carries the meaning. */
function statusBadge(doc: Document, status: string): HTMLElement {
  const look = statusLook(status);
  const wrap = el(doc, 'span', `status tone-${look.tone}`);
  const glyph = el(doc, 'span', 'glyph', look.glyph);
  glyph.setAttribute('aria-hidden', 'true');
  wrap.append(glyph, el(doc, 'span', 'status-label', look.label));
  return wrap;
}

function connectionBadge(doc: Document, connection: Connection): HTMLElement {
  const look =
    connection === 'live'
      ? { glyph: '●', word: W.live, tone: 'working' }
      : connection === 'connecting'
        ? { glyph: '◌', word: W.connecting, tone: 'idle' }
        : { glyph: '▲', word: W.retrying, tone: 'needs-you' };
  const wrap = el(doc, 'span', `connection tone-${look.tone}`);
  wrap.setAttribute('role', 'status');
  const glyph = el(doc, 'span', 'glyph', look.glyph);
  glyph.setAttribute('aria-hidden', 'true');
  wrap.append(glyph, el(doc, 'span', 'connection-word', look.word));
  return wrap;
}

/** The bar and its words, or null when there is no estimate at all (no bare `—` line). */
function progress(doc: Document, agent: PhoneAgentView): HTMLElement | null {
  const words = progressWords(agent.progress);
  if (words === null) return null;
  const wrap = el(doc, 'span', 'progress');
  if (agent.progress.fraction !== null) {
    const bar = el(doc, 'span', 'bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el(doc, 'span', 'bar-fill');
    fill.style.width = `${String(Math.round(agent.progress.fraction * 100))}%`;
    bar.append(fill);
    wrap.append(bar);
  }
  wrap.append(el(doc, 'span', 'progress-words', words));
  return wrap;
}

function actLine(doc: Document, a: ActState | undefined): HTMLElement | null {
  if (a === undefined) return null;
  if (a.state === 'error') {
    const p = el(doc, 'p', 'inline-error', a.message);
    p.setAttribute('role', 'alert');
    return p;
  }
  const p = el(doc, 'p', 'decision-status', a.state === 'sending' ? W.sending : a.message);
  p.setAttribute('role', 'status');
  return p;
}

/** A subagent: one short row (status, name, role, progress, what it is doing now). */
function agentRow(doc: Document, agent: PhoneAgentView): HTMLElement {
  const row = el(doc, 'li', `agent depth-${String(Math.min(agent.depth, 4))}`);
  const head = el(doc, 'div', 'agent-head');
  head.append(statusBadge(doc, agent.status), el(doc, 'span', 'agent-name', agent.name));
  row.append(head);
  const meta = el(doc, 'div', 'agent-meta');
  if (agent.role !== '') meta.append(el(doc, 'span', 'agent-role', agent.role));
  const prog = progress(doc, agent);
  if (prog !== null) meta.append(prog);
  if (meta.childElementCount > 0) row.append(meta);
  if (agent.activity !== null) row.append(el(doc, 'p', 'agent-doing', agent.activity));
  return row;
}

/** The disabled controls' reasons, each said once ("Pause, Stop: This agent is no longer running."). */
function reasonLines(doc: Document, key: string, named: [string, PhoneControl][]): HTMLElement | null {
  const byReason = new Map<string, string[]>();
  for (const [name, c] of named) {
    if (c.enabled || c.reason === null) continue;
    byReason.set(c.reason, [...(byReason.get(c.reason) ?? []), name]);
  }
  if (byReason.size === 0) return null;
  const box = el(doc, 'div', 'reasons');
  box.id = `reasons-${key}`;
  for (const [reason, names] of byReason) box.append(el(doc, 'p', 'reason', `${names.join(', ')}: ${reason}`));
  return box;
}

function controlButton(
  doc: Document,
  text: string,
  className: string,
  focusKey: string,
  c: PhoneControl,
  describedBy: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = button(doc, text, className, focusKey, onClick);
  if (!c.enabled) {
    b.disabled = true;
    b.setAttribute('aria-describedby', describedBy);
  }
  return b;
}

/** Stop is off because Huddle did not launch this run (the view sends the shared RUN_REASONS sentence). */
function startedInTerminal(agent: PhoneAgentView): boolean {
  return !agent.controls.stop.enabled && agent.controls.stop.reason === RUN_REASONS.notManaged;
}

/** The main agent's controls: Message…, Pause or Resume, Stop… (with the composer or the Stop question when open). */
function agentControls(doc: Document, agent: PhoneAgentView, ui: MainUi, on: MainHandlers): HTMLElement {
  const box = el(doc, 'div', 'controls');
  const key = agent.key;
  const sending = ui.actions[agentActKey(key)]?.state === 'sending';
  if (ui.composer === key && agent.controls.message.enabled) {
    const group = el(doc, 'div', 'composer');
    group.setAttribute('role', 'group');
    const label = el(doc, 'label', 'field-label', W.messageLabel);
    const area = el(doc, 'textarea', 'text-input message-input');
    area.id = `msg-${key}`;
    label.htmlFor = area.id;
    area.maxLength = PHONE_TEXT_MAX;
    area.rows = 3;
    area.value = ui.messageDrafts[key] ?? '';
    area.dataset['focus'] = `msg:${key}`;
    area.addEventListener('input', () => {
      on.typeMessage(key, area.value);
    });
    group.append(label, area);
    if (agent.messageLands !== null) {
      group.append(el(doc, 'p', 'muted small', `${W.messageLands} ${agent.messageLands}.`));
    }
    const row = el(doc, 'div', 'actions');
    const send = button(doc, W.messageSend, 'pill primary', `msg-send:${key}`, () => {
      on.sendMessage(key);
    });
    if (sending) send.disabled = true;
    row.append(
      send,
      button(doc, W.messageCancel, 'pill secondary', `msg-cancel:${key}`, () => {
        on.openComposer(null);
      }),
    );
    group.append(row);
    box.append(group);
  } else if (ui.confirmStop === key && agent.controls.stop.enabled) {
    const group = el(doc, 'div', 'confirm');
    group.setAttribute('role', 'group');
    const q = el(doc, 'p', 'confirm-text', W.stopConfirm);
    q.id = `stop-q-${key}`;
    group.setAttribute('aria-labelledby', q.id);
    const row = el(doc, 'div', 'actions');
    const yes = button(doc, W.stop, 'pill danger', `stop-yes:${key}`, () => {
      on.stop(key);
    });
    if (sending) yes.disabled = true;
    row.append(
      yes,
      button(doc, W.back, 'pill secondary', `stop-back:${key}`, () => {
        on.askStop(null);
      }),
    );
    group.append(q, row);
    box.append(group);
  } else {
    const c = agent.controls;
    const reasonsId = `reasons-${key}`;
    const row = el(doc, 'div', 'actions');
    row.append(
      controlButton(doc, W.messageAsk, 'pill secondary', `msg-open:${key}`, c.message, reasonsId, () => {
        on.openComposer(key);
      }),
    );
    // One of Pause and Resume: Resume while it is paused (or pausing), else Pause.
    const showResume = c.resume.enabled;
    const pr: PhoneControl = showResume ? c.resume : c.pause;
    const prButton = controlButton(
      doc,
      showResume ? W.resume : W.pause,
      'pill secondary',
      `${showResume ? 'resume' : 'pause'}:${key}`,
      pr,
      reasonsId,
      () => {
        on.control(key, showResume ? 'resume' : 'pause');
      },
    );
    if (sending) prButton.disabled = true;
    row.append(prButton);
    // A session started in a terminal: no dead Stop and no per-card sentence; the Agents section says it once.
    const terminalOnly = startedInTerminal(agent);
    if (!terminalOnly) {
      const stopButton = controlButton(doc, W.stopAsk, 'pill secondary', `stop:${key}`, c.stop, reasonsId, () => {
        on.askStop(key);
      });
      if (sending) stopButton.disabled = true;
      row.append(stopButton);
    }
    box.append(row);
    const reasons = reasonLines(doc, key, [
      [W.messageAsk.replace('…', ''), c.message],
      [showResume ? W.resume : W.pause, pr],
      ...(terminalOnly ? [] : ([[W.stop, c.stop]] as [string, PhoneControl][])),
    ]);
    if (reasons !== null) box.append(reasons);
  }
  const line = actLine(doc, ui.actions[agentActKey(key)]);
  if (line !== null) box.append(line);
  return box;
}

/**
 * What the session's open Needs you items are about ("needs approval", "looks stuck"), each said once, or [] when
 * nothing of this session is listed there. The card then points up instead of repeating the item.
 */
function needWords(s: PhoneSessionView, view: PhoneView | null): string[] {
  const keys = new Set(s.agents.map((a) => a.key));
  const mine = (view?.inbox ?? []).filter((i) => keys.has(i.agentKey));
  const words = [
    ...mine.filter((i) => i.kind === 'approval').map(() => W.needsApproval),
    ...mine.filter((i) => i.kind === 'question').map(() => W.needsAnswer),
    ...mine.filter((i) => i.kind !== 'approval' && i.kind !== 'question').map((i) => noticeWords(i.kind)),
  ];
  return [...new Set(words)];
}

/**
 * One session (F26 slop review): a compact summary by default (status, title, project, and one line: what it needs
 * from above, else its progress and what it is doing now), as a real disclosure button. Expanded, it also shows the
 * main agent's controls and the subagents. Expansion is kept per rootKey by the app, so a live update keeps it open.
 */
function sessionCard(doc: Document, s: PhoneSessionView, ui: MainUi, on: MainHandlers): HTMLElement {
  const open = ui.expanded[s.rootKey] === true;
  const card = el(doc, 'section', open ? 'card session open' : 'card session');
  const root = s.agents[0];
  const bodyId = `session-body-${s.rootKey}`;

  const heading = el(doc, 'h3', 'session-heading');
  const summary = button(doc, '', 'session-summary', `session:${s.rootKey}`, () => {
    on.toggleSession(s.rootKey);
  });
  summary.setAttribute('aria-expanded', open ? 'true' : 'false');
  // Only point at the body while it exists (a collapsed card does not render it).
  if (open) summary.setAttribute('aria-controls', bodyId);
  const head = el(doc, 'span', 'session-head');
  if (root !== undefined) head.append(statusBadge(doc, root.status));
  head.append(el(doc, 'span', 'session-title', s.title));
  const chevron = el(doc, 'span', 'chevron', open ? '▾' : '▸');
  chevron.setAttribute('aria-hidden', 'true');
  head.append(chevron);
  summary.append(head);
  if (s.project !== null && s.project !== s.title) summary.append(el(doc, 'span', 'session-project', s.project));

  // The status badge already says the lead's own need ("needs an answer"); the line adds only what it does not.
  const said = root === undefined ? null : statusLook(root.status).label;
  const needs = needWords(s, ui.view).filter((w) => w !== said);
  if (needWords(s, ui.view).length > 0) {
    const line = el(doc, 'span', 'session-need tone-needs-you');
    const glyph = el(doc, 'span', 'glyph', '▲');
    glyph.setAttribute('aria-hidden', 'true');
    line.append(glyph, doc.createTextNode(` ${[...needs, W.seeAbove].join(' · ')}`));
    summary.append(line);
  } else if (root !== undefined) {
    const bar = progress(doc, root);
    if (bar !== null) {
      const prog = el(doc, 'span', 'session-progress');
      prog.append(el(doc, 'span', 'sr-only', `${W.progressLabel}: `), bar);
      summary.append(prog);
    }
    if (root.activity !== null) {
      const doing = el(doc, 'span', 'doing');
      doing.append(el(doc, 'span', 'doing-label', `${W.doingNow} `), doc.createTextNode(root.activity));
      summary.append(doing);
    }
  }
  heading.append(summary);
  card.append(heading);
  if (!open || root === undefined) return card;

  const body = el(doc, 'div', 'session-body');
  body.id = bodyId;
  body.append(agentControls(doc, root, ui, on));
  const subs = s.agents.slice(1);
  if (subs.length > 0) {
    const t = el(doc, 'h4', 'subagents-title', W.subagentsTitle);
    const list = el(doc, 'ul', 'agents');
    for (const a of subs) list.append(agentRow(doc, a));
    body.append(t, list);
  }
  card.append(body);
  return card;
}

function decisionLine(doc: Document, d: DecisionState | undefined): HTMLElement | null {
  if (d === undefined) return null;
  if (d.state === 'error') {
    const p = el(doc, 'p', 'inline-error', d.message);
    p.setAttribute('role', 'alert');
    return p;
  }
  const p = el(
    doc,
    'p',
    'decision-status',
    d.state === 'sending' ? W.sending : d.decision === 'allow' ? W.allowSent : W.denySent,
  );
  p.setAttribute('role', 'status');
  return p;
}

/**
 * The session an inbox item belongs to, under the agent's name: "Lead agent" alone does not say which run asked
 * (slop review 2026-11-18). A text node; null when the agent is not in the view or the title repeats the name.
 */
function sessionLine(doc: Document, view: PhoneView | null, agentKey: string, agentName: string): HTMLElement[] {
  const title = view?.sessions.find((s) => s.agents.some((a) => a.key === agentKey))?.title ?? null;
  return title === null || title === agentName ? [] : [el(doc, 'p', 'item-session', title)];
}

function approvalCard(doc: Document, item: PhoneApprovalView, ui: MainUi, on: MainHandlers): HTMLElement {
  const card = el(doc, 'li', 'card item approval');
  const head = el(doc, 'div', 'item-head');
  const kind = el(doc, 'span', 'item-kind tone-needs-you');
  const glyph = el(doc, 'span', 'glyph', '▲');
  glyph.setAttribute('aria-hidden', 'true');
  kind.append(glyph, el(doc, 'span', '', ' needs approval'));
  head.append(kind, el(doc, 'span', 'item-time', clock(item.createdAt)));
  const who = el(doc, 'p', 'item-who');
  who.append(el(doc, 'span', 'item-agent', item.agentName), el(doc, 'span', 'item-tool', item.toolName));
  const summary = el(doc, 'p', 'item-summary code', item.summary);
  card.append(head, who, ...sessionLine(doc, ui.view, item.agentKey, item.agentName), summary);
  // AX-01: the summary does not show the whole command, so the phone offers Deny only (the server refuses Allow too).
  if (item.hidden) card.append(el(doc, 'p', 'item-hidden', W.hiddenNote));

  const d = ui.decisions[item.requestId];
  const busy = d !== undefined && d.state !== 'error';
  if (!busy) {
    const actions = el(doc, 'div', 'actions');
    if (ui.confirmDeny === item.requestId) {
      const group = el(doc, 'div', 'confirm');
      group.setAttribute('role', 'group');
      const q = el(doc, 'p', 'confirm-text', W.denyConfirm);
      q.id = `deny-q-${item.id}`;
      group.setAttribute('aria-labelledby', q.id);
      const row = el(doc, 'div', 'actions');
      row.append(
        button(doc, W.deny, 'pill danger', `deny-yes:${item.requestId}`, () => {
          on.decide(item.requestId, 'deny');
        }),
        button(doc, W.back, 'pill secondary', `deny-back:${item.requestId}`, () => {
          on.askDeny(null);
        }),
      );
      group.append(q, row);
      card.append(group);
    } else {
      if (!item.hidden) {
        actions.append(
          button(doc, W.allow, 'pill primary', `allow:${item.requestId}`, () => {
            on.decide(item.requestId, 'allow');
          }),
        );
      }
      actions.append(
        button(doc, W.denyAsk, 'pill secondary', `deny:${item.requestId}`, () => {
          on.askDeny(item.requestId);
        }),
      );
      card.append(actions);
    }
  }
  const line = decisionLine(doc, d);
  if (line !== null) card.append(line);
  return card;
}

/** A held question: each question as a group of choices (radio or checkbox) and its own answer box, then Send. */
function questionCard(doc: Document, item: PhoneQuestionView, ui: MainUi, on: MainHandlers): HTMLElement {
  const card = el(doc, 'li', 'card item question');
  const head = el(doc, 'div', 'item-head');
  const kind = el(doc, 'span', 'item-kind tone-needs-you');
  const glyph = el(doc, 'span', 'glyph', '?');
  glyph.setAttribute('aria-hidden', 'true');
  kind.append(glyph, el(doc, 'span', '', W.questionKind));
  head.append(kind, el(doc, 'span', 'item-time', clock(item.createdAt)));
  const who = el(doc, 'p', 'item-who');
  who.append(el(doc, 'span', 'item-agent', item.agentName));
  card.append(head, who, ...sessionLine(doc, ui.view, item.agentKey, item.agentName));

  const state = ui.actions[answerKey(item.requestId)];
  const done = state !== undefined && state.state !== 'error';
  if (!item.answer.enabled || done) {
    for (const q of item.questions) card.append(el(doc, 'p', 'item-title', q.question));
    if (!item.answer.enabled && item.answer.reason !== null) card.append(el(doc, 'p', 'reason', item.answer.reason));
  } else {
    const draft = ui.answerDrafts[item.requestId];
    const form = el(doc, 'div', 'answer-form');
    item.questions.forEach((q, qi) => {
      const set = el(doc, 'fieldset', 'question-part');
      const legend = el(doc, 'legend', 'question-text');
      if (q.header !== null && q.header !== '') legend.append(el(doc, 'span', 'question-header', q.header));
      legend.append(el(doc, 'span', 'question-words', q.question));
      set.append(legend, el(doc, 'p', 'muted small', q.multiSelect ? W.pickMany : W.pickOne));
      const chosen = draft?.choices[qi] ?? [];
      q.options.forEach((o, oi) => {
        const id = `opt-${item.id}-${String(qi)}-${String(oi)}`;
        const label = el(doc, 'label', 'option');
        label.htmlFor = id;
        const box = el(doc, 'input', 'option-input');
        box.type = q.multiSelect ? 'checkbox' : 'radio';
        box.id = id;
        box.name = `q-${item.id}-${String(qi)}`;
        box.checked = chosen.includes(oi);
        box.dataset['focus'] = id;
        box.addEventListener('change', () => {
          on.choose(item.requestId, qi, oi, box.checked, !q.multiSelect);
        });
        const words = el(doc, 'span', 'option-words');
        words.append(el(doc, 'span', 'option-label', o.label));
        if (o.description !== null && o.description !== '') {
          words.append(el(doc, 'span', 'option-desc', o.description));
        }
        label.append(box, words);
        set.append(label);
      });
      const otherId = `other-${item.id}-${String(qi)}`;
      const otherLabel = el(doc, 'label', 'field-label small', W.questionOther);
      otherLabel.htmlFor = otherId;
      const other = el(doc, 'input', 'text-input');
      other.id = otherId;
      other.maxLength = PHONE_TEXT_MAX;
      other.autocomplete = 'off';
      other.value = draft?.other[qi] ?? '';
      other.dataset['focus'] = otherId;
      other.addEventListener('input', () => {
        on.typeOther(item.requestId, qi, other.value);
      });
      set.append(otherLabel, other);
      form.append(set);
    });
    const row = el(doc, 'div', 'actions');
    const send = button(doc, W.questionSend, 'pill primary', `answer:${item.requestId}`, () => {
      on.answer(item.requestId);
    });
    row.append(send);
    form.append(row);
    card.append(form);
  }
  const line = actLine(doc, state);
  if (line !== null) card.append(line);
  return card;
}

function noticeCard(
  doc: Document,
  item: Exclude<PhoneInboxItem, PhoneApprovalView | PhoneQuestionView>,
  view: PhoneView | null,
): HTMLElement {
  const card = el(doc, 'li', 'card item notice');
  const head = el(doc, 'div', 'item-head');
  const kind = el(doc, 'span', 'item-kind tone-idle');
  const glyph = el(doc, 'span', 'glyph', '!');
  glyph.setAttribute('aria-hidden', 'true');
  kind.append(glyph, el(doc, 'span', '', ` ${noticeWords(item.kind)}`));
  head.append(kind, el(doc, 'span', 'item-time', clock(item.createdAt)));
  const who = el(doc, 'p', 'item-who');
  who.append(el(doc, 'span', 'item-agent', item.agentName));
  card.append(
    head,
    who,
    ...sessionLine(doc, view, item.agentKey, item.agentName),
    el(doc, 'p', 'item-title', item.title),
    el(doc, 'p', 'muted', W.noticeHelp),
  );
  return card;
}

/**
 * The main screen: header, Needs you (approvals, then questions), the sessions, then the one-line limits and Forget.
 * The limits sit at the foot (slop review 2026-11-18): on top they pushed the first approval down on every visit.
 */
export function renderMain(doc: Document, ui: MainUi, on: MainHandlers): HTMLElement {
  const page = el(doc, 'main', 'page');
  const header = el(doc, 'header', 'page-head');
  header.append(el(doc, 'h1', 'page-title', W.title), connectionBadge(doc, ui.connection));
  page.append(header);
  if (ui.note !== null) page.append(el(doc, 'p', 'note', ui.note));

  const view = ui.view;
  if (view === null) {
    page.append(el(doc, 'p', 'muted', W.waitingForFirst));
  } else {
    const inbox = el(doc, 'section', 'inbox');
    inbox.setAttribute('aria-labelledby', 'inbox-title');
    const title = el(doc, 'h2', 'section-title', W.inboxTitle);
    title.id = 'inbox-title';
    if (view.inbox.length > 0) title.append(el(doc, 'span', 'section-count', ` ${String(view.inbox.length)}`));
    inbox.append(title);
    if (view.inbox.length === 0) inbox.append(el(doc, 'p', 'muted', W.inboxEmpty));
    else {
      const list = el(doc, 'ul', 'items');
      for (const item of view.inbox) if (item.kind === 'approval') list.append(approvalCard(doc, item, ui, on));
      for (const item of view.inbox) if (item.kind === 'question') list.append(questionCard(doc, item, ui, on));
      for (const item of view.inbox) {
        if (item.kind !== 'approval' && item.kind !== 'question') list.append(noticeCard(doc, item, view));
      }
      inbox.append(list);
    }
    page.append(inbox);

    const sessions = el(doc, 'section', 'sessions');
    sessions.setAttribute('aria-labelledby', 'sessions-title');
    const st = el(doc, 'h2', 'section-title', W.sessionsTitle);
    st.id = 'sessions-title';
    sessions.append(st);
    if (view.sessions.length === 0) sessions.append(el(doc, 'p', 'muted', W.sessionsEmpty));
    for (const s of view.sessions) sessions.append(sessionCard(doc, s, ui, on));
    // Said once for every session Huddle did not launch, instead of a dead Stop and its sentence on each card.
    const roots = view.sessions.flatMap((s) => s.agents.slice(0, 1));
    if (roots.some(startedInTerminal)) sessions.append(el(doc, 'p', 'sessions-note', W.terminalStop));
    page.append(sessions);
  }

  const foot = el(doc, 'footer', 'page-foot');
  foot.append(el(doc, 'p', 'limits', W.limits));
  if (ui.confirmForget) {
    const group = el(doc, 'div', 'confirm');
    group.setAttribute('role', 'group');
    const q = el(doc, 'p', 'confirm-text', W.forgetConfirm);
    q.id = 'forget-q';
    group.setAttribute('aria-labelledby', q.id);
    const row = el(doc, 'div', 'actions');
    row.append(
      button(doc, W.forget, 'pill danger', 'forget-yes', () => {
        on.forget();
      }),
      button(doc, W.back, 'pill secondary', 'forget-back', () => {
        on.askForget(false);
      }),
    );
    group.append(q, row);
    foot.append(group);
  } else {
    foot.append(
      button(doc, W.forgetAsk, 'quiet', 'forget', () => {
        on.askForget(true);
      }),
    );
  }
  page.append(foot);
  return page;
}

/** The pairing screen: the code, a name for the phone, Pair. */
export function renderPairing(doc: Document, ui: PairUi, on: PairHandlers): HTMLElement {
  const page = el(doc, 'main', 'page pairing');
  const header = el(doc, 'header', 'page-head');
  header.append(el(doc, 'h1', 'page-title', W.title));
  page.append(header);
  if (ui.notice !== null) {
    const n = el(doc, 'p', 'note', ui.notice);
    n.setAttribute('role', 'status');
    page.append(n);
  }
  const form = el(doc, 'form', 'card pair-form');
  form.noValidate = true;
  form.append(el(doc, 'h2', 'section-title', W.pairTitle), el(doc, 'p', 'muted', W.pairIntro));

  const codeLabel = el(doc, 'label', 'field-label', W.codeLabel);
  codeLabel.htmlFor = 'pair-code';
  const code = el(doc, 'input', 'text-input code-input');
  code.id = 'pair-code';
  code.name = 'code';
  code.inputMode = 'numeric';
  code.autocomplete = 'one-time-code';
  code.maxLength = 6;
  code.pattern = '[0-9]{6}';
  code.value = ui.code;
  code.dataset['focus'] = 'pair-code';
  if (ui.error !== null) {
    code.setAttribute('aria-invalid', 'true');
    code.setAttribute('aria-describedby', 'pair-error');
  }

  const nameLabel = el(doc, 'label', 'field-label', W.nameLabel);
  nameLabel.htmlFor = 'pair-name';
  const name = el(doc, 'input', 'text-input');
  name.id = 'pair-name';
  name.name = 'name';
  name.maxLength = 60;
  name.autocomplete = 'off';
  name.value = ui.name;
  name.setAttribute('aria-describedby', 'pair-name-help');
  const nameHelp = el(doc, 'p', 'muted small', W.nameHelp);
  nameHelp.id = 'pair-name-help';

  const submit = el(doc, 'button', 'pill primary', ui.busy ? W.pairing : W.pairButton);
  submit.type = 'submit';
  submit.dataset['focus'] = 'pair-submit';
  if (ui.busy) submit.disabled = true;

  form.append(codeLabel, code, nameLabel, name, nameHelp);
  if (ui.error !== null) {
    const err = el(doc, 'p', 'inline-error', ui.error);
    err.id = 'pair-error';
    err.setAttribute('role', 'alert');
    form.append(err);
  }
  form.append(submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (ui.busy) return;
    on.pair(code.value, name.value);
  });
  page.append(form, el(doc, 'p', 'limits', W.limits));
  return page;
}
