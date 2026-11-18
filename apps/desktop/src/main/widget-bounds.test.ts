import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampHeight,
  clampToDisplays,
  loadWidgetBounds,
  mainUrlSelecting,
  parseOpenMainRequest,
  saveWidgetBounds,
  WIDGET_MARGIN,
  WIDGET_MIN_HEIGHT,
  type Rect,
} from './widget-bounds.js';
import { WIDGET_MAX_HEIGHT, WIDGET_WIDTH } from './windows.js';

const primary: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const right: Rect = { x: 1920, y: 0, width: 2560, height: 1400 };

function inside(r: Rect, area: Rect): boolean {
  return (
    r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height
  );
}

describe('clampToDisplays', () => {
  it('places a first-run widget at the top right of the primary display', () => {
    const r = clampToDisplays(null, [primary], primary);
    expect(r).toMatchObject({ x: 1920 - WIDGET_WIDTH - WIDGET_MARGIN, y: WIDGET_MARGIN, width: WIDGET_WIDTH });
    expect(inside(r, primary)).toBe(true);
  });

  it('keeps a saved position on a display that is still connected', () => {
    const saved = { x: 2400, y: 300, width: WIDGET_WIDTH, height: 200 };
    expect(clampToDisplays(saved, [primary, right], primary)).toEqual(saved);
  });

  it('moves the widget back to the primary display when its monitor is gone', () => {
    const saved = { x: 2400, y: 300, width: WIDGET_WIDTH, height: 200 };
    const r = clampToDisplays(saved, [primary], primary);
    expect(inside(r, primary)).toBe(true);
    expect(r.height).toBe(200);
  });

  it('pulls a half-off-screen widget fully onto the display it mostly overlaps', () => {
    const r = clampToDisplays({ x: 1800, y: -50, width: WIDGET_WIDTH, height: 300 }, [primary, right], primary);
    expect(inside(r, primary) || inside(r, right)).toBe(true);
  });

  it('treats a sliver of overlap as not visible', () => {
    const r = clampToDisplays({ x: 1910, y: 1030, width: WIDGET_WIDTH, height: 200 }, [primary], primary);
    expect(r.x).toBe(1920 - WIDGET_WIDTH - WIDGET_MARGIN);
  });

  it('caps height at 480 and at the work area', () => {
    expect(clampHeight(2000)).toBe(WIDGET_MAX_HEIGHT);
    expect(clampHeight(10)).toBe(WIDGET_MIN_HEIGHT);
    expect(clampHeight(400, 300)).toBe(300);
    expect(clampHeight(Number.NaN)).toBe(WIDGET_MIN_HEIGHT);
    // The widget collapsed to one line is its 40 px header; the window must be allowed to shrink to it.
    expect(WIDGET_MIN_HEIGHT).toBe(40);
    expect(clampHeight(40)).toBe(40);
  });
});

describe('remembered bounds file', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('round-trips and treats a missing or malformed file as none', async () => {
    dir = await mkdtemp(join(tmpdir(), 'huddle-widget-'));
    const file = join(dir, 'nested', 'widget-bounds.json');
    expect(await loadWidgetBounds(file)).toBeNull();
    await saveWidgetBounds(file, { x: 10.4, y: 20, width: WIDGET_WIDTH, height: 200 });
    expect(await loadWidgetBounds(file)).toEqual({ x: 10, y: 20, width: WIDGET_WIDTH, height: 200 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ x: 10, y: 20, width: WIDGET_WIDTH, height: 200 });
    await writeFile(file, '{"x":"evil"}');
    expect(await loadWidgetBounds(file)).toBeNull();
    await writeFile(file, 'not json');
    expect(await loadWidgetBounds(file)).toBeNull();
  });
});

describe('parseOpenMainRequest: only the main view URL', () => {
  const main = 'http://localhost:5173/?view=main';
  it('accepts exactly the main view URL and nothing else', () => {
    expect(parseOpenMainRequest('http://localhost:5173/?view=main', main)).not.toBeNull();
    expect(parseOpenMainRequest('http://localhost:5173/?view=widget', main)).toBeNull();
    expect(parseOpenMainRequest('https://example.com/?view=main', main)).toBeNull();
    expect(parseOpenMainRequest('not a url', main)).toBeNull();
  });
});

describe('parseOpenMainRequest (widget row selects an agent)', () => {
  const main = 'http://localhost:5173/?view=main';
  const file = 'file:///C:/app/out/renderer/index.html?view=main';
  const key = 'session-1::agent-1';

  it('accepts the main view URL alone, and with one well-formed agent key', () => {
    expect(parseOpenMainRequest(main, main)).toEqual({ agentKey: null });
    expect(parseOpenMainRequest(`${main}&agent=${encodeURIComponent(key)}`, main)).toEqual({ agentKey: key });
    expect(parseOpenMainRequest(`${main}&agent=session-1`, main)).toEqual({ agentKey: 'session-1' });
    expect(parseOpenMainRequest(`${file}&agent=${encodeURIComponent(key)}`, file)).toEqual({ agentKey: key });
  });

  it.each([
    ['another origin', `https://example.com/?view=main&agent=${key}`],
    ['another port', `http://localhost:5174/?view=main&agent=${key}`],
    ['another path', `http://localhost:5173/x?view=main&agent=${key}`],
    ['credentials', `http://user:pw@localhost:5173/?view=main&agent=${key}`],
    ['the widget view', `http://localhost:5173/?view=widget&agent=${key}`],
    ['parameters swapped', `http://localhost:5173/?agent=${key}&view=main`],
    ['an extra parameter', `${main}&agent=${key}&x=1`],
    ['a repeated agent', `${main}&agent=${key}&agent=other`],
    ['an empty agent', `${main}&agent=`],
    ['a fragment', `${main}&agent=${key}#x`],
    ['an empty fragment', `${main}#`],
    ['script in the key', `${main}&agent=${encodeURIComponent('<script>alert(1)</script>')}`],
    ['a javascript: key', `${main}&agent=${encodeURIComponent('javascript:alert(1)')}`],
    ['path traversal', `${main}&agent=${encodeURIComponent('../../etc/passwd')}`],
    ['a space', `${main}&agent=a%20b`],
    ['a newline', `${main}&agent=a%0Ab`],
    ['three colons', `${main}&agent=a:::b`],
    ['a trailing separator', `${main}&agent=a::`],
    ['bad percent encoding', `${main}&agent=%E0%A4%A`],
    ['an encoded ampersand', `${main}&agent=a%26view%3Dwidget`],
    ['an over-long key', `${main}&agent=${'a'.repeat(257)}`],
    ['a huge value', `${main}&agent=${'%41'.repeat(5000)}`],
    ['not a URL', 'not a url'],
  ])('rejects %s', (_name, url) => {
    expect(parseOpenMainRequest(url, main)).toBeNull();
  });

  it('builds a fragment-only URL for an open main window, and refuses a malformed key', () => {
    expect(mainUrlSelecting(main, key)).toBe(`${main}#agent=${encodeURIComponent(key)}`);
    expect(mainUrlSelecting(`${main}#agent=old`, 'session-2')).toBe(`${main}#agent=session-2`);
    expect(mainUrlSelecting(main, '<b>')).toBeNull();
    expect(mainUrlSelecting('nope', key)).toBeNull();
  });
});
