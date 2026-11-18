/**
 * The widget's visibility rules (M6 P6, owner decision 2026-11-16): a start at sign-in opens the widget like a normal
 * start, and the user can close it; a closed widget stays closed until the tray (icon or menu) or the global shortcut
 * shows it again, or the next start. State changes and toasts never show it (a toast opens the main window).
 *
 * index.ts is Electron glue with no seams for a unit test, so this reads its source: every call that shows the widget
 * must sit in one of the functions that are allowed to show it. A new caller fails here and has to be added on purpose.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isHideWidgetRequest, parseOpenMainRequest } from './widget-bounds.js';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/);

/** The name of the top-level function (or `app.on(...)` callback marker) that encloses line `index`. */
function enclosingFunction(index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const m = /^(?:export )?(?:async )?function (\w+)/.exec(lines[i] ?? '');
    if (m?.[1] !== undefined) return m[1];
    if (/^\S/.test(lines[i] ?? '') && i !== index && !/^[}\])]/.test(lines[i] ?? ''))
      return `top level: ${lines[i] ?? ''}`;
  }
  return 'top level';
}

function callers(pattern: RegExp): string[] {
  const out = new Set<string>();
  lines.forEach((line, i) => {
    if (pattern.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/function showWidget/.test(line))
      out.add(enclosingFunction(i));
  });
  return [...out].sort();
}

describe('the widget stays closed until the user asks for it', () => {
  it('is shown only by the start, the global shortcut and the tray toggle', () => {
    expect(callers(/\bshowWidget\(/)).toEqual(['onShortcut', 'start', 'toggleWidget']);
  });

  it('the tray toggle is the only other caller of toggleWidget (tray icon click and tray menu)', () => {
    expect(callers(/\btoggleWidget\b(?!\(\): void)/)).toEqual(['createTray']);
  });

  it('a toast click opens the main window, never the widget', () => {
    const body = source.slice(source.indexOf('function openToast'), source.indexOf('function startShortcut'));
    expect(body).toContain('showMainWindow');
    expect(body).not.toMatch(/showWidget|toggleWidget|widgetWindow/);
  });

  it('closing the widget (Alt+F4) hides it instead of closing it', () => {
    const create = source.slice(source.indexOf('async function createWidget'), source.indexOf('let widgetPending'));
    expect(create).toMatch(
      /win\.on\('close', \(event\) => \{\s*if \(!quitting\) \{\s*event\.preventDefault\(\);\s*win\.hide\(\);/,
    );
  });

  it('a start at sign-in is an ordinary start: main never asks how it was started', () => {
    expect(source).not.toMatch(/wasOpenedAtLogin|wasOpenedAsHidden|openAsHidden/);
  });
});

describe("the widget's hide control (window.open of a URL main recognises, no IPC)", () => {
  const WIDGET = 'http://localhost:5173/?view=widget';
  const MAIN = 'http://localhost:5173/?view=main';

  it('accepts exactly <widget view URL>&hide=1', () => {
    expect(isHideWidgetRequest(`${WIDGET}&hide=1`, WIDGET)).toBe(true);
    expect(
      isHideWidgetRequest(
        'file:///C:/app/out/renderer/index.html?view=widget&hide=1',
        'file:///C:/app/out/renderer/index.html?view=widget',
      ),
    ).toBe(true);
  });

  it('refuses every other shape', () => {
    for (const url of [
      WIDGET,
      `${WIDGET}&hide=0`,
      `${WIDGET}&hide=1&x=1`,
      `${WIDGET}&hide=1#`,
      `${WIDGET}&hide=1#x`,
      'http://localhost:5174/?view=widget&hide=1',
      'http://evil.example/?view=widget&hide=1',
      'http://user@localhost:5173/?view=widget&hide=1',
      'http://localhost:5173/other?view=widget&hide=1',
      `${MAIN}&hide=1`,
      'not a url',
    ])
      expect(isHideWidgetRequest(url, WIDGET), url).toBe(false);
  });

  it('is never taken for an open-main request, and the other way round', () => {
    expect(parseOpenMainRequest(`${WIDGET}&hide=1`, MAIN)).toBeNull();
    expect(isHideWidgetRequest(MAIN, WIDGET)).toBe(false);
  });

  it('main hides (never closes) the widget, and only for a request from the widget itself', () => {
    expect(source).toMatch(
      /isHideWidgetRequest\(url, viewUrl\('widget'\)\) && widgetWindow\?\.webContents === contents\) hideWidget\(\);/,
    );
    const body = source.slice(source.indexOf('function hideWidget'), source.indexOf('/** Outside app.asar'));
    expect(body).toContain('widgetWindow.hide()');
    expect(body).not.toMatch(/\.close\(|\.destroy\(/);
  });

  it('the renderer does not use window.close() for it (that destroys the window)', () => {
    const widgetView = readFileSync(new URL('../renderer/src/views/WidgetView.tsx', import.meta.url), 'utf8');
    expect(widgetView).not.toMatch(/window\.close\(\)\s*;/);
    const deepLink = readFileSync(new URL('../renderer/src/view/deep-link.ts', import.meta.url), 'utf8');
    expect(deepLink).toContain("url.search = '?view=widget&hide=1';");
  });
});
