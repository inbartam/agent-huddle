/**
 * Window security settings in one pure module, so tests can assert them without starting Electron.
 * See docs/SECURITY.md.
 */
import type { WebPreferences } from 'electron';

/** webPreferences for every BrowserWindow (main window and widget). */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
  };
}

type Directives = ReadonlyArray<readonly [name: string, ...sources: string[]]>;

/**
 * Production policy. Everything comes from the packaged files; no inline script, no eval,
 * no remote origin. React's `style={{...}}` writes through the CSSOM, which CSP does not block,
 * so `style-src 'self'` is enough for the built bundle.
 */
const PRODUCTION: Directives = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['style-src', "'self'"],
  ['img-src', "'self'", 'data:'],
  ['font-src', "'self'"],
  ['connect-src', "'self'"],
  ['media-src', "'none'"],
  ['object-src', "'none'"],
  ['frame-src', "'none'"],
  ['worker-src', "'none'"],
  ['manifest-src', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
  ['frame-ancestors', "'none'"],
];

/**
 * Development policy, looser only where the Vite dev server needs it:
 * inline <style> tags for CSS HMR, the React Refresh inline preamble script, and the HMR websocket
 * on the local dev server. Still no eval and no remote host.
 */
const DEVELOPMENT: Directives = PRODUCTION.map((d): readonly [string, ...string[]] => {
  switch (d[0]) {
    case 'script-src':
      return ['script-src', "'self'", "'unsafe-inline'"];
    case 'style-src':
      return ['style-src', "'self'", "'unsafe-inline'"];
    case 'connect-src':
      return ['connect-src', "'self'", 'ws://localhost:*', 'ws://127.0.0.1:*'];
    default:
      return d;
  }
});

/** Directives that browsers ignore (with a console warning) when delivered in a <meta> tag. */
const HEADER_ONLY = new Set(['frame-ancestors', 'report-uri', 'sandbox']);

export type CspMode = 'production' | 'development';

/**
 * The Content-Security-Policy string.
 * `delivery: 'meta'` drops header-only directives; the response header (dev server) carries them all.
 */
export function contentSecurityPolicy(mode: CspMode, delivery: 'header' | 'meta' = 'header'): string {
  const directives = mode === 'production' ? PRODUCTION : DEVELOPMENT;
  return directives
    .filter(([name]) => delivery === 'header' || !HEADER_ONLY.has(name))
    .map((d) => d.join(' '))
    .join('; ');
}

/**
 * May the window navigate to `url`? Only within the app's own origin (the dev server in dev,
 * the packaged index.html in production). Everything else, including links in agent text, is blocked.
 */
export function isAllowedNavigation(url: string, appUrl: string): boolean {
  let target: URL;
  let app: URL;
  try {
    target = new URL(url);
    app = new URL(appUrl);
  } catch {
    return false;
  }
  if (app.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === app.pathname;
  }
  return target.origin === app.origin;
}

/** Is an IPC message from a frame showing our own renderer? Same test as navigation. */
export function isTrustedSender(frameUrl: string | undefined, appUrl: string): boolean {
  return typeof frameUrl === 'string' && isAllowedNavigation(frameUrl, appUrl);
}
