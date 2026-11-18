import { describe, expect, it } from 'vitest';
import { mainWindowOptions, supportsBackgroundMaterial, widgetWindowOptions, WIDGET_WIDTH } from './windows.js';

const base = { preloadPath: 'C:\\app\\out\\preload\\index.cjs', dark: true };

describe('supportsBackgroundMaterial', () => {
  it('needs Windows 11 22H2 or later', () => {
    expect(supportsBackgroundMaterial('win32', '10.0.26200')).toBe(true);
    expect(supportsBackgroundMaterial('win32', '10.0.22621')).toBe(true);
    expect(supportsBackgroundMaterial('win32', '10.0.22000')).toBe(false);
    expect(supportsBackgroundMaterial('win32', '10.0.19045')).toBe(false);
    expect(supportsBackgroundMaterial('linux', '6.8.0')).toBe(false);
    expect(supportsBackgroundMaterial('win32', 'garbage')).toBe(false);
  });
});

describe('window options', () => {
  for (const [name, make] of [
    ['main', mainWindowOptions],
    ['widget', widgetWindowOptions],
  ] as const) {
    it(`${name} window uses the secure webPreferences`, () => {
      const prefs = make({ ...base, material: true }).webPreferences;
      expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
    });
  }

  it('main window: hidden title bar with token-coloured overlay, Mica, min 960x600', () => {
    const solid = mainWindowOptions({ ...base, material: false });
    expect(solid).toMatchObject({ titleBarStyle: 'hidden', minWidth: 960, minHeight: 600, backgroundColor: '#17181B' });
    expect(solid.titleBarOverlay).toMatchObject({ color: '#17181B', symbolColor: '#ECEDEF' });
    expect(solid.backgroundMaterial).toBeUndefined();

    const mica = mainWindowOptions({ ...base, dark: false, material: true });
    expect(mica.backgroundMaterial).toBe('mica');
    expect(mica.titleBarOverlay).toMatchObject({ symbolColor: '#1A1B1E' });
  });

  it('widget: frameless, always on top, off the taskbar, 340 px, Acrylic', () => {
    const w = widgetWindowOptions({ ...base, material: true });
    expect(w).toMatchObject({
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      width: WIDGET_WIDTH,
      backgroundMaterial: 'acrylic',
    });
    expect(widgetWindowOptions({ ...base, material: false }).backgroundColor).toBe('#17181B');
  });
});
