/**
 * The message composer (F12) and the queued outbox, as words and commands. Which modes are on comes from
 * `selectControls` (`message`, `messageTurnEnd`); where a message lands from `whereMessageLands`. Pure.
 */
import {
  CLIP_LIMITS,
  whereMessageLands,
  type AgentKey,
  type AgentNode,
  type ComposerMode,
  type ControlState,
  type ControlsView,
  type HuddleCommand,
  type MessageDelivery,
  type QueuedMessage,
} from '@huddle/shared';

export const MESSAGE_MAX = CLIP_LIMITS.message;

export interface ModeOption {
  mode: ComposerMode;
  label: string;
  control: ControlState;
}

/** The three delivery choices. End of turn follows `messageTurnEnd`; the other two follow `message`. */
export function modeOptions(controls: ControlsView): ModeOption[] {
  return [
    { mode: 'auto', label: 'First chance', control: controls.message },
    { mode: 'next_tool', label: 'Next tool call', control: controls.message },
    { mode: 'turn_end', label: 'End of turn', control: controls.messageTurnEnd },
  ];
}

/** The mode to use: the chosen one while it is on, else auto. */
export function effectiveMode(chosen: ComposerMode, controls: ControlsView): ComposerMode {
  return chosen === 'turn_end' && !controls.messageTurnEnd.enabled ? 'auto' : chosen;
}

/** The line under the composer: where the message will land. */
export function landingLine(agent: Pick<AgentNode, 'status' | 'capabilities'>, mode: ComposerMode): string {
  const where = whereMessageLands(agent, mode);
  if (where === 'agent is idle: when it next works') return 'The agent is idle: it gets this when it next works.';
  return `Lands ${where}.`;
}

/** The `agent.message` command, or null when there is nothing to send. Text is trimmed and clipped. */
export function messageCommand(agentKey: AgentKey, text: string, mode: ComposerMode): HuddleCommand | null {
  const body = text.trim().slice(0, MESSAGE_MAX);
  if (body === '') return null;
  return { type: 'agent.message', agentKey, text: body, delivery: mode };
}

export function cancelMessageCommand(agentKey: AgentKey, messageId: string): HuddleCommand {
  return { type: 'message.cancel', agentKey, messageId };
}

/** How a queued message's delivery reads in the outbox list. */
export function deliveryWords(delivery: MessageDelivery): string {
  switch (delivery) {
    case 'next_tool':
      return 'at the next tool call';
    case 'turn_end':
      return 'at the end of the turn';
    case 'auto':
      return 'at the first chance';
    case 'live':
      return 'at once';
  }
}

export function pauseCommand(agentKey: AgentKey): HuddleCommand {
  return { type: 'agent.pause', agentKey };
}

export function resumeCommand(agentKey: AgentKey): HuddleCommand {
  return { type: 'agent.resume', agentKey };
}

export const MESSAGE_AUTHOR_WORDS = {
  user: 'From you',
  /** ADR-027: the lead check on an idle teammate, written by the Huddle itself (`QueuedMessage.author: 'huddle'`). */
  huddle: 'Automatic check by Agent Huddle',
  huddleTitle:
    'Agent Huddle wrote this message itself: it asks the lead whether an idle teammate is finished or waiting. Turn it off in Settings, Agent teams.',
} as const;

/** Who wrote a queued message, as the outbox shows it. */
export function messageAuthorWords(message: Pick<QueuedMessage, 'author'>): string {
  return message.author === 'huddle' ? MESSAGE_AUTHOR_WORDS.huddle : MESSAGE_AUTHOR_WORDS.user;
}
