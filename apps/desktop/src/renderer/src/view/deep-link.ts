/**
 * "Open the main window on this agent" (widget row click). No IPC channel is involved:
 *  1. the widget calls window.open(`<own URL>?view=main&agent=<key>`); main's window-open handler validates that
 *     exact shape (main/widget-bounds.ts `parseOpenMainRequest`), denies the new window, and shows the main window;
 *  2. main puts the key in the main window's URL fragment (`#agent=<key>`): in the first load's URL, or later as a
 *     fragment-only navigation, which does not reload the page;
 *  3. the main view reads the fragment here, checks it against the agents in state, selects the agent and clears
 *     the fragment so the same agent can be asked for again.
 * Everything is checked against the AgentKey format; anything else is ignored.
 */
import { isAgentKeyFormat, type AgentKey, type HuddleState } from '@huddle/shared';

/** The URL the widget opens to ask for the main window, optionally on one agent. */
export function openMainUrl(currentHref: string, agentKey?: AgentKey): string {
  const url = new URL(currentHref);
  url.hash = '';
  url.search = '?view=main';
  if (agentKey !== undefined && isAgentKeyFormat(agentKey)) url.search += `&agent=${encodeURIComponent(agentKey)}`;
  return url.href;
}

/**
 * The URL the widget opens to ask main to hide it (M6 P6). Main's window-open handler accepts exactly this shape from
 * the widget's own page (main/widget-bounds.ts `isHideWidgetRequest`), hides the widget and denies the new window.
 */
export function hideWidgetUrl(currentHref: string): string {
  const url = new URL(currentHref);
  url.hash = '';
  url.search = '?view=widget&hide=1';
  return url.href;
}

/** The agent key in a `#agent=<encoded key>` fragment, or null for anything else. */
export function agentFromHash(hash: string): AgentKey | null {
  const m = /^#agent=([^&#]{1,1024})$/.exec(hash);
  if (!m?.[1]) return null;
  let key: string;
  try {
    key = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return isAgentKeyFormat(key) ? key : null;
}

/**
 * The agent to select for a fragment, given the state: the key only if it names an agent the state knows.
 * Null for no fragment, a malformed one, or an unknown agent (never guessed, never partially matched).
 */
export function linkedAgent(hash: string, state: Pick<HuddleState, 'agents'> | null): AgentKey | null {
  const key = agentFromHash(hash);
  if (key === null || state === null) return null;
  return Object.hasOwn(state.agents, key) ? key : null;
}

// --- #item=<id> (M3, F14): a toast click opens one inbox item ------------------------------------------------------
// Main shows the main window and sets the fragment to `#item=<encoded id>` (main/toasts.ts `mainUrlLinkingItem`), the
// same way as `#agent=`. Parsing only here; the inbox reacts to it (WP9).

/**
 * Longest item id accepted. Detector ids carry a cwd and a file path (`conflict:<cwd>:<path>`, each path up to
 * CLIP_LIMITS.path), so the bound is two paths plus a prefix. Must match `ITEM_ID_MAX` in main/toasts.ts.
 */
export const ITEM_ID_MAX = 2100;

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

/** Same rule as main's `isItemIdFormat`: 1..ITEM_ID_MAX characters, no control or bidi-override characters. */
export function isItemIdFormat(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ITEM_ID_MAX && !HAS_CONTROL.test(value);
}

/** The item id in an `#item=<encoded id>` fragment, or null for anything else. */
export function itemFromHash(hash: string): string | null {
  // Encoded, every character is at most 9 (a 3-byte UTF-8 character is %XX%XX%XX); refuse longer before decoding.
  if (hash.length > 6 + ITEM_ID_MAX * 9) return null;
  const m = /^#item=([^&#]+)$/.exec(hash);
  if (!m?.[1]) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return isItemIdFormat(id) ? id : null;
}

/**
 * The inbox item to open for a fragment: the id only if it names an item in the state's inbox (exact match). Null for
 * no fragment, a malformed one, or an unknown item. A resolved item still counts: the card shows how it ended.
 */
export function linkedItem(hash: string, state: Pick<HuddleState, 'inbox'> | null): string | null {
  const id = itemFromHash(hash);
  if (id === null || state === null) return null;
  return state.inbox.some((item) => item.id === id) ? id : null;
}
