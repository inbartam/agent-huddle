import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isAllowedNavigation, isTrustedSender, secureWebPreferences } from './security.js';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name = '', ...sources]) => [name, sources]),
  );
}

describe('secureWebPreferences', () => {
  const prefs = secureWebPreferences('C:\\app\\out\\preload\\index.cjs');

  it('isolates and sandboxes the renderer', () => {
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.experimentalFeatures).toBe(false);
    expect(prefs.navigateOnDragDrop).toBe(false);
  });

  it('loads the CommonJS preload', () => {
    expect(prefs.preload).toMatch(/\.cjs$/);
  });
});

describe('production CSP', () => {
  const header = contentSecurityPolicy('production', 'header');
  const d = directives(header);

  it("defaults to 'self' and allows no inline script or eval", () => {
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(header).not.toContain("'unsafe-inline'");
    expect(header).not.toContain("'unsafe-eval'");
    expect(header).not.toContain("'wasm-unsafe-eval'");
  });

  it('names no remote host or scheme wildcard', () => {
    for (const sources of d.values()) {
      for (const source of sources) {
        expect(["'self'", "'none'", 'data:']).toContain(source);
      }
    }
  });

  it('locks down objects, base, forms and framing', () => {
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('meta delivery drops header-only directives and keeps the rest', () => {
    const meta = contentSecurityPolicy('production', 'meta');
    expect(meta).not.toContain('frame-ancestors');
    expect(directives(meta).get('script-src')).toEqual(["'self'"]);
  });
});

describe('development CSP', () => {
  const d = directives(contentSecurityPolicy('development'));

  it('loosens only what Vite needs, and only toward localhost', () => {
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('script-src')).not.toContain("'unsafe-eval'");
    for (const source of d.get('connect-src') ?? []) {
      expect(source === "'self'" || /^ws:\/\/(localhost|127\.0\.0\.1):\*$/.test(source)).toBe(true);
    }
  });
});

describe('isAllowedNavigation', () => {
  it('allows the dev server origin only', () => {
    expect(isAllowedNavigation('http://localhost:5173/#x', 'http://localhost:5173/')).toBe(true);
    expect(isAllowedNavigation('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
    expect(isAllowedNavigation('https://example.com/', 'http://localhost:5173/')).toBe(false);
  });

  it('allows only the packaged index.html under file:', () => {
    const app = 'file:///C:/app/out/renderer/index.html';
    expect(isAllowedNavigation('file:///C:/app/out/renderer/index.html#/agent', app)).toBe(true);
    expect(isAllowedNavigation('file:///C:/Windows/win.ini', app)).toBe(false);
    expect(isAllowedNavigation('https://example.com/', app)).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isAllowedNavigation('not a url', 'http://localhost:5173/')).toBe(false);
    expect(isTrustedSender(undefined, 'http://localhost:5173/')).toBe(false);
  });
});
