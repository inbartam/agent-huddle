/**
 * The phone page's words (M6, F26), in the same voice as docs/DESIGN.md "Words". Status glyphs and labels are the
 * desktop's own (`renderer/src/view/status.ts`), so a status reads the same on both: shape and label, colour only adds.
 */
import type { PhoneNoticeView } from '@huddle/shared';

export { statusLook } from '../renderer/src/view/status.js';

export const PHONE_WORDS = {
  title: 'Agent Huddle',
  limits:
    "From this phone you can approve, answer questions, message, pause, resume and stop. You can't launch agents, change rules or budgets, or open history.",
  pairTitle: 'Pair this phone',
  pairIntro:
    'On the computer, open Huddle, go to Settings, Phone access, and press "Pair a phone". Type the 6-digit code it shows.',
  codeLabel: 'Pairing code',
  nameLabel: 'Name for this phone',
  nameHelp: 'Shown in Huddle on the computer, so you can tell your phones apart.',
  pairButton: 'Pair',
  pairing: 'Pairing…',
  badCode: 'Type the 6-digit code shown in Huddle on the computer.',
  pairRefused: 'That code did not work. Check it, or press "Pair a phone" on the computer for a new one.',
  tooMany: 'Too many tries. Wait a minute, then try again.',
  unreachable:
    "Can't reach Huddle. Check that this phone is on the same network as the computer and that phone access is on.",
  pairBroken: 'Huddle answered in a way this page does not understand. Reload the page and try again.',
  signedOut:
    'This phone is not paired any more: it was revoked in Huddle, or Huddle forgot it. Pair it again with a new code.',
  forgotten: 'This phone forgot its pairing. To use it again, pair it with a new code.',
  noStorage:
    "This browser won't remember the pairing (private browsing or storage turned off): you will need to pair again after closing it.",
  live: 'Live',
  connecting: 'Connecting…',
  retrying: 'Reconnecting… showing the last update',
  inboxTitle: 'Needs you',
  inboxEmpty: 'Nothing is waiting on you.',
  sessionsTitle: 'Agents',
  sessionsEmpty: 'No agents running.',
  waitingForFirst: 'Waiting for the first update from Huddle…',
  allow: 'Allow',
  hiddenNote: 'Part of this command is hidden (masked or too long). Answer this one on the computer, or deny it here.',
  denyAsk: 'Deny…',
  denyConfirm: 'Deny this request? The agent is told no.',
  deny: 'Deny',
  back: 'Back',
  allowSent: 'Allow: Sent. Waiting for Claude Code…',
  denySent: 'Deny: Sent. Waiting for Claude Code…',
  sending: 'Sending…',
  decideGone: 'Not sent: this request was already answered or ran out of time.',
  decideBusy: "Not sent: Huddle can't take a decision right now. Try again.",
  decideUnreachable: "Not sent: can't reach Huddle. Try again.",
  noticeHelp: 'Handle this one on the computer.',
  // ADR-030: sessions, controls and questions
  doingNow: 'Now:',
  needsApproval: 'needs approval',
  needsAnswer: 'needs an answer',
  seeAbove: 'see above',
  terminalStop: 'Sessions started in a terminal can be stopped only from that terminal.',
  progressLabel: 'Progress (estimate)',
  subagentsTitle: 'Subagents',
  messageAsk: 'Message…',
  messageLabel: 'Message to the agent',
  messageLands: 'Lands',
  messageSend: 'Send',
  messageCancel: 'Cancel',
  messageEmpty: 'Type a message first.',
  pause: 'Pause',
  resume: 'Resume',
  stopAsk: 'Stop…',
  stopConfirm: "Stop this run? Huddle interrupts it and ends its process. This can't be undone.",
  stop: 'Stop',
  questionKind: ' asked a question',
  questionOther: 'Or type your own answer',
  questionSend: 'Send answer',
  questionPick: 'Choose an option or type your own answer for every question.',
  questionPickOne: 'Choose one option or type your own answer, not both.',
  pickMany: 'Choose any that apply',
  pickOne: 'Choose one',
  answerSent: 'Answer sent. Waiting for Claude Code…',
  messageSent: 'Message queued.',
  pauseSent: 'Pause sent.',
  resumeSent: 'Resume sent.',
  stopSent: 'Stop sent. The run is ending.',
  actGone: 'Not sent: this is no longer waiting, or it is not on this phone any more.',
  actRefused: 'Not sent: Huddle refused it.',
  forgetAsk: 'Forget this phone',
  forgetConfirm:
    "Forget this phone? It stops showing your agents until you pair it again. To cut it off for good, use Revoke in Huddle's Settings on the computer.",
  forget: 'Forget',
} as const;

export const NOTICE_WORDS: Record<PhoneNoticeView['kind'], string> = {
  stuck: 'looks stuck',
  loop: 'may be in a loop',
  file_conflict: 'file conflict',
  budget: 'budget',
  context_high: 'context is high',
  error: 'failed',
  finished: 'finished',
  role_drift: 'editing off-role',
};

/** The kind's words; a kind this page does not know (a newer core) reads as a plain notice. */
export function noticeWords(kind: string): string {
  return (NOTICE_WORDS as Record<string, string | undefined>)[kind] ?? 'notice';
}

/**
 * "3 of 5 tasks · ~40% est.", "~40% est.", or null when there is nothing to base an estimate on: the page leaves the
 * line out rather than show a bare `—` (slop review, F26).
 */
export function progressWords(progress: { fraction: number | null; label: string | null }): string | null {
  const pct = progress.fraction === null ? null : `~${String(Math.round(progress.fraction * 100))}% est.`;
  if (progress.label !== null && pct !== null) return `${progress.label} · ${pct}`;
  return progress.label ?? pct;
}

/** "17:02" in the phone's own time zone. */
export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A name to suggest for this phone, from the browser's user agent (the user can change it). */
export function guessDeviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? 'Android phone' : 'Android tablet';
  return 'Phone';
}
