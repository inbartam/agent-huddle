/**
 * Widget position and size (WP11): remembered in a small JSON file under app.getPath('userData'),
 * and clamped on start to a display that is still connected (monitors change between runs).
 * The geometry is pure so it can be tested without Electron; file access is the only side effect.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { isAgentKeyFormat, type AgentKey } from '@huddle/shared';
import { WIDGET_MAX_HEIGHT, WIDGET_WIDTH } from './windows.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The one-line widget (collapsed, Widget v2): its header is 40 px, so the window may shrink to that. Was 64. */
export const WIDGET_MIN_HEIGHT = 40;
/** Gap from the work-area edge when the widget is placed by default. */
export const WIDGET_MARGIN = 16;
/** A saved position counts as "on" a display only if at least this much of it is visible there. */
const MIN_VISIBLE_PX = 48;

const RectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export function clampHeight(height: number, workAreaHeight = Number.POSITIVE_INFINITY): number {
  const h = Number.isFinite(height) ? Math.round(height) : WIDGET_MIN_HEIGHT;
  return Math.max(WIDGET_MIN_HEIGHT, Math.min(h, WIDGET_MAX_HEIGHT, Math.floor(workAreaHeight)));
}

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/** Top-right corner of a work area, the widget's default spot. */
export function defaultWidgetBounds(area: Rect, height = 220): Rect {
  const h = clampHeight(height, area.height - 2 * WIDGET_MARGIN);
  return {
    x: area.x + area.width - WIDGET_WIDTH - WIDGET_MARGIN,
    y: area.y + WIDGET_MARGIN,
    width: WIDGET_WIDTH,
    height: h,
  };
}

/**
 * Where the widget should open. `saved` is the last remembered rect (or null); `workAreas` are the
 * connected displays' work areas, `primary` the primary display's. The result is always fully inside
 * one connected work area: the one the saved rect overlapped most, else the primary display's top right.
 */
export function clampToDisplays(saved: Rect | null, workAreas: readonly Rect[], primary: Rect): Rect {
  if (!saved) return defaultWidgetBounds(primary);
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlap(saved, area);
    if (o.w >= Math.min(MIN_VISIBLE_PX, saved.width) && o.h >= Math.min(MIN_VISIBLE_PX, saved.height)) {
      if (o.w * o.h > bestArea) {
        best = area;
        bestArea = o.w * o.h;
      }
    }
  }
  if (!best) return defaultWidgetBounds(primary, saved.height);
  return fitInside({ ...saved, width: WIDGET_WIDTH }, best);
}

/** Move (and if needed shrink) a rect so it lies fully inside `area`. */
export function fitInside(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width);
  const height = clampHeight(rect.height, area.height);
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

/** Read the remembered bounds; a missing, unreadable or malformed file means "none". */
export async function loadWidgetBounds(file: string): Promise<Rect | null> {
  try {
    const parsed = RectSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Write via a temp file and rename, so a crash mid-write never leaves a half file. */
export async function saveWidgetBounds(file: string, rect: Rect): Promise<void> {
  const data: Rect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const tmp = `${file}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Longest agent key a request may carry (decoded). */
export const OPEN_MAIN_AGENT_MAX = 256;

/**
 * Parse a renderer's window.open(url) as "show the main window". Accepted shapes, and nothing else:
 *   <main view URL>                       (same scheme, host, port and path; query exactly `view=main`)
 *   <main view URL>&agent=<encoded key>   (the key decodes to at most 256 characters in the AgentKey format)
 * No fragment, no credentials, no other or repeated parameters. Returns null for anything else.
 * The caller still denies the new window; this only tells it to show (and maybe select in) the main window.
 */
export function parseOpenMainRequest(url: string, mainViewUrl: string): { agentKey: AgentKey | null } | null {
  let target: URL;
  let main: URL;
  try {
    target = new URL(url);
    main = new URL(mainViewUrl);
  } catch {
    return null;
  }
  if (
    target.protocol !== main.protocol ||
    target.host !== main.host ||
    target.pathname !== main.pathname ||
    target.username !== '' ||
    target.password !== '' ||
    target.hash !== '' ||
    url.includes('#')
  )
    return null;
  if (target.search === main.search) return { agentKey: null };
  if (!target.search.startsWith(`${main.search}&agent=`)) return null;
  const raw = target.search.slice(main.search.length + '&agent='.length);
  // The encoded form of a 256-character key is at most 3 × 256 characters; refuse anything longer before decoding.
  if (raw === '' || raw.length > OPEN_MAIN_AGENT_MAX * 3 || /[&=#]/.test(raw)) return null;
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (key.length > OPEN_MAIN_AGENT_MAX || !isAgentKeyFormat(key)) return null;
  return { agentKey: key };
}

/**
 * Is a renderer's window.open(url) the widget's "hide me" request (M6 P6: the widget's hide control)? Accepted shape,
 * and nothing else: `<widget view URL>&hide=1` (same scheme, host, port and path; query exactly `view=widget&hide=1`;
 * no fragment, no credentials). The caller also checks the request came from the widget's own webContents, hides the
 * widget (never closes it) and still denies the new window. It exists because `window.close()` in the renderer closes
 * a BrowserWindow without a preventable `close` event, which would destroy the widget instead of hiding it.
 */
export function isHideWidgetRequest(url: string, widgetViewUrl: string): boolean {
  let target: URL;
  let widget: URL;
  try {
    target = new URL(url);
    widget = new URL(widgetViewUrl);
  } catch {
    return false;
  }
  return (
    target.protocol === widget.protocol &&
    target.host === widget.host &&
    target.pathname === widget.pathname &&
    target.username === '' &&
    target.password === '' &&
    target.hash === '' &&
    !url.includes('#') &&
    target.search === `${widget.search}&hide=1`
  );
}

/**
 * The URL that selects `agentKey` in a main window currently showing `currentUrl`: the same page with only the
 * fragment changed (`#agent=<key>`), so loading it is a same-document navigation, not a reload. Null when the key
 * is not a well-formed AgentKey or the URL cannot be parsed.
 */
export function mainUrlSelecting(currentUrl: string, agentKey: AgentKey): string | null {
  if (agentKey.length > OPEN_MAIN_AGENT_MAX || !isAgentKeyFormat(agentKey)) return null;
  try {
    const url = new URL(currentUrl);
    url.hash = `agent=${encodeURIComponent(agentKey)}`;
    return url.href;
  } catch {
    return null;
  }
}
