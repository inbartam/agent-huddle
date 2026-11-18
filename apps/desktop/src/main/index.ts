/**
 * Electron main process: hosts the core, owns the tray and the windows.
 * Window security lives in ./security.ts, window chrome in ./windows.ts, IPC in ./ipc.ts.
 */
import { promises as fsp } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  Notification,
  Tray,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  type WebContents,
} from 'electron';
import { DEFAULT_USER_SETTINGS } from '@huddle/shared';
import {
  HookInstaller,
  McpRegistrar,
  forgetConsent,
  HuddleCore,
  REPORTS_DIRNAME,
  WORKTREES_DIRNAME,
  defaultWorktreeDataDir,
  type HuddleLogger,
} from '@huddle/core';
import { APP_USER_MODEL_ID, pinnedUserDataPath } from './app-identity.js';
import { chooseCore, claudeConfigDirOf, shippedFiles, type CoreEnv } from './core-config.js';
import { isToolLaunch, parseLaunchMode, selfCheckTargetProblem } from './launch-mode.js';
import { createLoginItem } from './login-item.js';
import { removeHooks } from './remove-hooks.js';
import { shouldReload, startFailureText } from './startup-recovery.js';
import { selfCheckReport } from './self-check.js';
import { registerIpc } from './ipc.js';
import { createSystemActions, type SystemActions } from './system-actions.js';
import { createQuitGuard } from './quit.js';
import { contentSecurityPolicy, isAllowedNavigation } from './security.js';
import { createCoreSettingsHost, createMemorySettingsHost, type SettingsHost } from './settings-host.js';
import { createShortcutManager, shortcutAction, type ShortcutManager } from './shortcut.js';
import { createToastNotifier, electronShowToast, mainUrlLinkingItem, type Toast } from './toasts.js';
import {
  clampHeight,
  clampToDisplays,
  fitInside,
  loadWidgetBounds,
  mainUrlSelecting,
  parseOpenMainRequest,
  isHideWidgetRequest,
  saveWidgetBounds,
  type Rect,
} from './widget-bounds.js';
import {
  mainWindowOptions,
  supportsBackgroundMaterial,
  titleBarOverlay,
  widgetWindowOptions,
  WIDGET_WIDTH,
  windowBackground,
  type ChromeEnv,
} from './windows.js';

const isDev = !app.isPackaged && typeof process.env['ELECTRON_RENDERER_URL'] === 'string';
const here = import.meta.dirname;
const material = supportsBackgroundMaterial(process.platform, release());

/** Where the renderer lives: the Vite dev server in dev, the built index.html otherwise. */
function appUrl(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) return devUrl;
  return pathToFileURL(join(here, '../renderer/index.html')).href;
}

/** Both windows load the same bundle; `view` picks the layout. */
function viewUrl(view: 'main' | 'widget'): string {
  const url = new URL(appUrl());
  url.searchParams.set('view', view);
  return url.href;
}

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let core: SettingsHost | null = null;
let unregisterIpc: (() => void) | null = null;
let shortcuts: ShortcutManager | null = null;
let stopToasts: (() => void) | null = null;
let quitting = false;

/** Main-process log lines. The core never passes payload text, prompts or tokens here. */
const logger: HuddleLogger = {
  info: (message, data) => {
    console.log('[huddle]', message, data ?? '');
  },
  warn: (message, data) => {
    console.warn('[huddle]', message, data ?? '');
  },
  error: (message, data) => {
    console.error('[huddle]', message, data ?? '');
  },
};

/** The paths and env main resolves files from (core-config.ts). */
function coreEnv(): CoreEnv {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    homedir: homedir(),
    env: process.env,
    execPath: process.execPath,
  };
}

// Pin the data folder before anything reads userData (the single-instance lock, the core, the tool modes): the packaged
// app's package name is "Agent Huddle" (install folder), the data stays in %APPDATA%\@huddle\desktop (app-identity.ts).
{
  const pinned = pinnedUserDataPath(app.getPath('appData'), app.commandLine.hasSwitch('user-data-dir'), join);
  if (pinned !== null) app.setPath('userData', pinned);
}

const launch = parseLaunchMode(process.argv);

if (launch.kind === 'invalid') {
  console.error(`[huddle] ${launch.reason}`);
  app.exit(2);
} else if (launch.kind === 'self-check') {
  // Spike S23: one JSON report about this build, then exit. No core, no window, no lock (self-check.ts).
  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    const report = await selfCheckReport({
      ...coreEnv(),
      versions: process.versions,
      platform: process.platform,
      appUserModelId: APP_USER_MODEL_ID,
      loginItem: app.getLoginItemSettings({ path: process.execPath, args: [] }),
    });
    // Only a new file in the temp folder, never inside Claude Code's folder (launch-mode.ts); 'wx' refuses one that exists.
    const problem = await selfCheckTargetProblem(launch.out, {
      tmpDir: tmpdir(),
      claudeConfigDir: claudeConfigDirOf(coreEnv()),
      realpath: (p) => fsp.realpath(p),
    });
    if (problem !== null) {
      console.error(`[huddle] ${problem}`);
      app.exit(2);
      return;
    }
    try {
      await fsp.writeFile(launch.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST';
      console.error(
        exists
          ? `[huddle] ${launch.out} already exists; the self-check writes only a new file. Pick another name.`
          : `[huddle] the self-check report could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
      app.exit(2);
      return;
    }
    app.exit(0);
  });
} else if (launch.kind === 'remove-hooks') {
  // The packaged "remove hooks" command (remove-hooks.ts). Holding the lock means no Huddle is running meanwhile.
  const alone = app.requestSingleInstanceLock();
  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    const e = coreEnv();
    const configDir = claudeConfigDirOf(e);
    const files = shippedFiles(e);
    const installer = new HookInstaller({
      configDir,
      now: () => new Date(),
      // Never used: an uninstall writes no token.
      newToken: () => '',
      forwarderSource: files.forwarder,
    });
    // The same registrar the core builds (huddle-core.ts): same config folder, home folder and env.
    const registrar = new McpRegistrar({ configDir, homeDir: e.homedir, serverSource: files.mcpServer });
    const result = await removeHooks(
      { installer, registrar, forgetConsent: () => forgetConsent(e.userData) },
      { alreadyRunning: !alone },
    );
    console.log(`[huddle] ${result.title}: ${result.lines.join(' ')}`);
    await dialog.showMessageBox({
      type: result.ok ? 'info' : 'warning',
      title: 'Agent Huddle',
      message: result.title,
      detail: result.lines.join('\n\n'),
      buttons: ['OK'],
    });
    app.exit(result.ok ? 0 : 1);
  });
} else if (!app.requestSingleInstanceLock()) {
  // A second launch focuses the first instance and exits.
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // `--remove-hooks` and the self-check run as their own short process; they never open the main window here.
    if (isToolLaunch(argv)) return;
    showMainWindow();
  });
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      console.error('Agent Huddle failed to start', err);
      dialog.showErrorBox('Agent Huddle could not start', startFailureText(err));
      app.quit();
    });
}

async function start(): Promise<void> {
  // Before any notification, or Windows toasts do not appear.
  app.setAppUserModelId(APP_USER_MODEL_ID);
  Menu.setApplicationMenu(null);
  hardenSession();

  const choice = chooseCore(coreEnv());
  // P6: the Windows login item, only in a packaged Windows build (login-item.ts); absent elsewhere.
  const loginItem = createLoginItem(app, {
    packaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    appUserModelId: APP_USER_MODEL_ID,
  });
  let huddle: HuddleCore | null = null;
  // ADR-017 pattern: HuddleState.settings is filled next to the core's state (settings-host.ts).
  let settingsHost: SettingsHost;
  if (choice.kind === 'canned') {
    // Dev screenshots only (`$env:HUDDLE_DEV_CANNED='1'`); chooseCore never picks this in a packaged build.
    // Settings stay in memory; one fresh item arrives after 4 s so a toast can be seen.
    // `import.meta.env.DEV` is false in a production build, so the bundler drops this import and no canned chunk ships.
    if (!import.meta.env.DEV) throw new Error('Canned dev data is not part of a production build.');
    const { createCannedCore } = await import('./canned-core.js');
    const canned = createCannedCore({ tickMs: 5000, freshItemAfterMs: 4000 });
    settingsHost = createMemorySettingsHost(canned, DEFAULT_USER_SETTINGS, { loginItem });
    console.log('[huddle] HUDDLE_DEV_CANNED=1: serving canned dev data, no hooks, no listener');
  } else {
    // The core owns the preferences: it validates and saves settings.update and adopts the file's copy at start.
    huddle = new HuddleCore({ ...choice.deps, logger });
    settingsHost = createCoreSettingsHost(huddle, { loginItem });
    logger.info('claude config folder', { dir: choice.deps.claudeConfigDir });
  }
  core = settingsHost;
  unregisterIpc = registerIpc(settingsHost, appUrl, { system: systemActions() });
  startToasts(settingsHost);
  startShortcut(settingsHost);

  // Dev only: force a theme for screenshots (`$env:HUDDLE_DEV_THEME='light'`). Settings will own this later.
  const devTheme = process.env['HUDDLE_DEV_THEME'];
  if (isDev && (devTheme === 'light' || devTheme === 'dark')) nativeTheme.themeSource = devTheme;

  nativeTheme.on('updated', applyTheme);
  createTray();
  // Owner decision (2026-11-13): the widget opens at start; the main window waits in the tray.
  void showWidget();
  // Dev convenience: `$env:HUDDLE_DEV_MAIN='1'; npm run dev` also opens the main window.
  if (isDev && process.env['HUDDLE_DEV_MAIN'] === '1') showMainWindow();

  if (huddle) {
    // Replays the log, listens, and attaches if the owner agreed before (ADR-014). Never rejects.
    const started = await huddle.start();
    if (!started.ok) logger.error('not receiving events', { code: started.code });
    // First run: the widget cannot show the settings diff, so the main window opens for consent.
    if (huddle.getState().connection?.status === 'needs_consent' && !quitting) showMainWindow();
  }
}

/** F14: a toast for every new attention item (switchable per kind); a click opens it in the main window. */
function startToasts(host: SettingsHost): void {
  const showToast = electronShowToast({
    isSupported: () => Notification.isSupported(),
    create: (options) => new Notification(options),
  });
  const show: typeof showToast = (toast, onClick) => {
    // Dev only: which toast went out (its dedupe key's kind, never its text).
    if (isDev) console.log(`[huddle] toast (${toast.key.split(':')[0] ?? ''}${toast.itemId ? ', opens item' : ''})`);
    showToast(toast, onClick);
  };
  const notify = createToastNotifier({
    getState: () => host.getState(),
    getSettings: () => host.settings(),
    show,
    onClick: openToast,
  });
  stopToasts = host.onEvents(notify);
}

/**
 * The folder picker and "Open in VS Code" (ADR-020). The worktrees root is the core's default worktree folder
 * (`%LOCALAPPDATA%/agent-huddle/worktrees`); nothing outside it is ever opened. M5: run reports open from
 * `<userData>/reports` only (the core's dataDir is userData, core-config.ts).
 */
function systemActions(): SystemActions {
  return createSystemActions({
    worktreesRoot: join(defaultWorktreeDataDir(), WORKTREES_DIRNAME),
    platform: process.platform,
    showOpenDialog: (owner, options) =>
      owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
    isDirectory: (p) =>
      fsp.stat(p).then(
        (s) => s.isDirectory(),
        () => false,
      ),
    realpath: (p) => fsp.realpath(p),
    protocolHandler: (url) => app.getApplicationNameForProtocol(url),
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p),
    reportsRoot: join(app.getPath('userData'), REPORTS_DIRNAME),
    isFile: (p) =>
      fsp.stat(p).then(
        (s) => s.isFile(),
        () => false,
      ),
    writeClipboard: (text) => clipboard.writeText(text),
  });
}

function openToast(toast: Toast): void {
  if (toast.itemId !== null) showMainWindowAt({ item: toast.itemId });
  else showMainWindow(toast.agentKey);
}

/** F15: the global shortcut shows and focuses the widget (or hides it when focused); re-registered on change. */
function startShortcut(host: SettingsHost): void {
  shortcuts = createShortcutManager(globalShortcut, onShortcut, (status) => {
    host.setShortcutStatus(status);
    if (!status.registered) logger.warn('global shortcut not registered', { accelerator: status.accelerator });
  });
  shortcuts.apply(host.settings().globalShortcut);
  host.onSettingsChanged((next) => {
    shortcuts?.apply(next.globalShortcut);
  });
}

function onShortcut(): void {
  const win = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow : null;
  const action = shortcutAction(win ? { visible: win.isVisible(), focused: win.isFocused() } : null);
  if (isDev) console.log(`[huddle] shortcut: ${action} widget`);
  if (action === 'hide') {
    win?.hide();
    return;
  }
  void showWidget(true);
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  // Header CSP for responses from the dev server; the built index.html carries the same policy in a meta tag.
  const csp = contentSecurityPolicy(isDev ? 'development' : 'production', 'header');
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
}

// Every webContents (including any created later): no navigation away, no new windows, no <webview>.
app.on('web-contents-created', (_event, contents: WebContents) => {
  // A crashed renderer is reloaded once a minute at most, so the window does not stay blank (A4-02). Only the reason is logged.
  let lastReloadAt: number | null = null;
  contents.on('render-process-gone', (_e, details) => {
    console.warn('[huddle] renderer gone:', details.reason);
    if (details.reason === 'clean-exit' || contents.isDestroyed()) return;
    const now = Date.now();
    if (!shouldReload(lastReloadAt, now)) return;
    lastReloadAt = now;
    contents.reload();
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, appUrl())) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url, appUrl())) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  // No window is ever opened. Two requests are recognised, and the new window is denied either way (no IPC channel):
  //  - the widget asking for the main window (our own main view URL, optionally with `&agent=<key>`, validated in
  //    parseOpenMainRequest); main shows it and selects the agent through the main window's URL fragment;
  //  - the widget's hide control (`<widget view URL>&hide=1`, isHideWidgetRequest), only from the widget itself:
  //    main hides the widget to the tray (M6 P6). It stays hidden until the tray, the shortcut or the next start.
  contents.setWindowOpenHandler(({ url }) => {
    const request = parseOpenMainRequest(url, viewUrl('main'));
    if (request) showMainWindow(request.agentKey);
    else if (isHideWidgetRequest(url, viewUrl('widget')) && widgetWindow?.webContents === contents) hideWidget();
    return { action: 'deny' };
  });
  if (isDev) {
    // Dev only: surface renderer warnings and errors (CSP violations among them) in the terminal.
    contents.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') console.warn(`[renderer] ${event.message}`);
    });
  }
});

function chromeEnv(): ChromeEnv {
  return {
    preloadPath: join(here, '../preload/index.cjs'),
    dark: nativeTheme.shouldUseDarkColors,
    material,
    iconPath: iconPath(),
  };
}

/** Follow the system theme in the parts the renderer cannot paint: caption buttons and window base. */
function applyTheme(): void {
  const dark = nativeTheme.shouldUseDarkColors;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay(titleBarOverlay(dark, material));
    mainWindow.setBackgroundColor(windowBackground(dark, material, 'bg'));
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.setBackgroundColor(windowBackground(dark, material, 'surface'));
  }
}

/** What the main window should open on: an agent (`#agent=`) or an inbox item (`#item=`, from a toast). */
type MainLink = { agent: string } | { item: string };

function linkUrl(current: string, link: MainLink): string | null {
  return 'agent' in link ? mainUrlSelecting(current, link.agent) : mainUrlLinkingItem(current, link.item);
}

function createMainWindow(link: MainLink | null = null): BrowserWindow {
  const win = new BrowserWindow(mainWindowOptions(chromeEnv()));
  win.once('ready-to-show', () => {
    win.show();
  });
  // Closing the window hides it; the tray keeps the Huddle (and the hook listener) alive.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Windows log-off or shutdown does not emit before-quit; take the same quit path.
  win.on('session-end', () => {
    app.quit();
  });
  // A first load asked for from a widget row (or a toast) carries the agent (or item) in the fragment.
  const first = link === null ? null : linkUrl(viewUrl('main'), link);
  win.loadURL(first ?? viewUrl('main')).catch((err: unknown) => {
    logger.warn('main window failed to load', { error: String(err) });
  });
  return win;
}

/**
 * Select an agent in a main window that is already loaded, without a new IPC channel and without a reload:
 * loading the current URL with only the fragment changed is a same-document navigation, which the renderer sees
 * as `hashchange`. The renderer clears the fragment after reading it, so a repeat request changes the URL again.
 */
function selectInMainWindow(win: BrowserWindow, link: MainLink): void {
  const current = win.webContents.getURL();
  if (!isAllowedNavigation(current, appUrl())) return;
  const next = linkUrl(current, link);
  if (next === null) return;
  win.loadURL(next).catch(() => {
    /* a fragment-only navigation has nothing to fail on; ignore an aborted promise */
  });
}

/** Show the main window; with a (validated) agent key, also select that agent. */
function showMainWindow(agentKey: string | null = null): void {
  showMainWindowAt(agentKey === null ? null : { agent: agentKey });
}

/** Show the main window, opened on an agent or an inbox item (both validated before they reach the URL). */
function showMainWindowAt(link: MainLink | null): void {
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    // A new window shows itself on ready-to-show; showing it now would flash a blank window.
    mainWindow = createMainWindow(link);
    return;
  }
  if (link !== null) selectInMainWindow(mainWindow, link);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function widgetBoundsFile(): string {
  return join(app.getPath('userData'), 'widget-bounds.json');
}

function workAreas(): { all: Rect[]; primary: Rect } {
  return { all: screen.getAllDisplays().map((d) => d.workArea), primary: screen.getPrimaryDisplay().workArea };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function rememberWidgetBounds(win: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (win.isDestroyed()) return;
    saveWidgetBounds(widgetBoundsFile(), win.getBounds()).catch((err: unknown) => {
      console.warn('[huddle] could not save widget position', err);
    });
  }, 400);
}

/** Grow or shrink the widget to its content (max 480 px), keeping it on its display. */
function fitWidgetToContent(win: BrowserWindow, contentHeight: number): void {
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  // Width is always pinned: frameless rounded windows can report a few pixels more than they were given.
  const next = fitInside({ ...bounds, width: WIDGET_WIDTH, height: clampHeight(contentHeight, area.height) }, area);
  if (next.height !== bounds.height || next.y !== bounds.y || next.x !== bounds.x || next.width !== bounds.width)
    win.setBounds(next);
}

async function createWidget(): Promise<BrowserWindow> {
  const { all, primary } = workAreas();
  const bounds = clampToDisplays(await loadWidgetBounds(widgetBoundsFile()), all, primary);
  const win = new BrowserWindow({ ...widgetWindowOptions(chromeEnv()), ...bounds });
  win.once('ready-to-show', () => {
    win.showInactive();
  });
  win.webContents.on('preferred-size-changed', (_event, size) => {
    fitWidgetToContent(win, size.height);
  });
  win.on('moved', () => {
    rememberWidgetBounds(win);
  });
  win.on('resized', () => {
    rememberWidgetBounds(win);
  });
  // Closing the widget (Alt+F4) hides it like the main window; the tray brings it back.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (widgetWindow === win) widgetWindow = null;
  });
  win.on('session-end', () => {
    app.quit();
  });
  // A display was removed or rearranged: pull the widget back onto one that is connected.
  const reclamp = () => {
    if (win.isDestroyed()) return;
    const areas = workAreas();
    win.setBounds(clampToDisplays(win.getBounds(), areas.all, areas.primary));
  };
  screen.on('display-removed', reclamp);
  screen.on('display-metrics-changed', reclamp);
  win.on('closed', () => {
    screen.off('display-removed', reclamp);
    screen.off('display-metrics-changed', reclamp);
  });
  win.loadURL(viewUrl('widget')).catch((err: unknown) => {
    logger.warn('widget window failed to load', { error: String(err) });
  });
  return win;
}

let widgetPending: Promise<BrowserWindow> | null = null;

/** Show the widget; `focus` (the global shortcut) also gives it keyboard focus, otherwise it never steals focus. */
async function showWidget(focus = false): Promise<void> {
  if (!app.isReady()) return;
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    widgetPending ??= createWidget();
    const win = await widgetPending;
    widgetWindow = win;
    widgetPending = null;
    if (focus)
      win.once('show', () => {
        win.focus();
      });
    return; // shown on ready-to-show
  }
  if (focus) {
    widgetWindow.show();
    widgetWindow.focus();
  } else widgetWindow.showInactive();
}

function toggleWidget(): void {
  if (widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) widgetWindow.hide();
  else void showWidget();
}

/** The widget's own hide control: hide, never close (the window and its state stay for the next show). */
function hideWidget(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
}

/** Outside app.asar when packaged (extraResources), apps/desktop/resources in dev (core-config.ts). */
function iconPath(): string {
  return shippedFiles(coreEnv()).icon;
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image);
  tray.setToolTip('Agent Huddle');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show main window',
        click: () => {
          showMainWindow();
        },
      },
      {
        label: 'Show or hide widget',
        click: () => {
          toggleWidget();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
  // Owner decision (2026-11-13): a left click toggles the widget; the menu opens the main window.
  tray.on('click', () => {
    toggleWidget();
  });
  if (isDev)
    console.log(`[huddle] tray icon ready (empty=${String(image.isEmpty())}) at ${JSON.stringify(tray.getBounds())}`);
}

// The tray keeps the app running when every window is closed.
app.on('window-all-closed', () => {
  /* stay alive in the tray */
});

/**
 * Every quit (tray Quit, a second launch's app.quit(), Windows ending the session) arrives here. The guard
 * holds the first one, disposes the core once (held responses released, hooks detached, telemetry kept,
 * log flushed; bounded at 3 s and never rejecting), then quits for real; repeats while that runs are ignored.
 * Closing a window only hides it (the tray keeps Huddle running), so it is not a quit.
 */
const quitGuard = createQuitGuard({
  timeoutMs: 3000,
  shutdown: async () => {
    shortcuts?.dispose();
    shortcuts = null;
    stopToasts?.();
    stopToasts = null;
    unregisterIpc?.();
    unregisterIpc = null;
    const widget = widgetWindow && !widgetWindow.isDestroyed() ? widgetWindow.getBounds() : null;
    const saved = widget ? saveWidgetBounds(widgetBoundsFile(), widget).catch(() => undefined) : Promise.resolve();
    await Promise.all([core ? core.dispose() : Promise.resolve(), saved]);
  },
  quit: () => {
    tray?.destroy();
    tray = null;
    app.quit();
  },
  onError: (error) => {
    console.error('[huddle] shutdown failed', error);
  },
});

app.on('before-quit', (event) => {
  quitting = true;
  if (quitGuard.requestQuit()) event.preventDefault();
});
