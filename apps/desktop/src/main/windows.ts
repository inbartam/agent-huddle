/**
 * BrowserWindow options for the main window and the widget, as pure functions so tests can check
 * them without Electron. Chrome follows docs/DESIGN.md ("Windows-native chrome"); security comes from
 * secureWebPreferences and is identical for both windows.
 */
import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron';
import { secureWebPreferences } from './security.js';

/** Colour tokens from docs/DESIGN.md that the main process needs (caption buttons, window base). */
export const CHROME_TOKENS = {
  dark: { bg: '#17181B', surface: '#17181B', text: '#ECEDEF' },
  light: { bg: '#F3F3F1', surface: '#F3F3F1', text: '#1A1B1E' },
} as const;

export const TITLE_BAR_HEIGHT = 36;
export const WIDGET_WIDTH = 340;
export const WIDGET_MAX_HEIGHT = 480;

/** Mica and Acrylic need Windows 11 22H2 (build 22621) or later. */
export function supportsBackgroundMaterial(platform: string, osRelease: string): boolean {
  if (platform !== 'win32') return false;
  const [major, , build] = osRelease.split('.').map((n) => Number.parseInt(n, 10));
  return major === 10 && typeof build === 'number' && build >= 22621;
}

export interface ChromeEnv {
  preloadPath: string;
  dark: boolean;
  /** Result of supportsBackgroundMaterial for this machine. */
  material: boolean;
  iconPath?: string;
}

export function titleBarOverlay(dark: boolean, material: boolean): TitleBarOverlay {
  const t = dark ? CHROME_TOKENS.dark : CHROME_TOKENS.light;
  // Over Mica the caption strip stays transparent so the material shows through.
  return { color: material ? '#00000000' : t.bg, symbolColor: t.text, height: TITLE_BAR_HEIGHT };
}

/** Solid base colour, or fully transparent when a system material paints the background. */
export function windowBackground(dark: boolean, material: boolean, token: 'bg' | 'surface'): string {
  if (material) return '#00000000';
  return (dark ? CHROME_TOKENS.dark : CHROME_TOKENS.light)[token];
}

export function mainWindowOptions(env: ChromeEnv): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Agent Huddle',
    ...(env.iconPath ? { icon: env.iconPath } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(env.dark, env.material),
    backgroundColor: windowBackground(env.dark, env.material, 'bg'),
    ...(env.material ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: secureWebPreferences(env.preloadPath),
  };
}

export function widgetWindowOptions(env: ChromeEnv): BrowserWindowConstructorOptions {
  return {
    width: WIDGET_WIDTH,
    height: 220,
    minWidth: WIDGET_WIDTH,
    maxWidth: WIDGET_WIDTH,
    maxHeight: WIDGET_MAX_HEIGHT,
    show: false,
    title: 'Agent Huddle widget',
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: true,
    backgroundColor: windowBackground(env.dark, env.material, 'surface'),
    ...(env.material ? { backgroundMaterial: 'acrylic' as const } : {}),
    // Preferred-size mode makes the renderer report its content size ('preferred-size-changed'), so main
    // can grow the widget with its content without any IPC channel. It adds no capability to the page.
    webPreferences: { ...secureWebPreferences(env.preloadPath), enablePreferredSizeMode: true },
  };
}
