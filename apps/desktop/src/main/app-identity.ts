/**
 * The app's Windows identity. electron-builder.json uses the same value as `appId`: NSIS gives the Start menu
 * shortcut this AppUserModelID, and toasts only show and group under the shortcut when main sets the same id
 * (packaging.test.ts keeps the two equal). The login item's registry value is named after it too.
 */
export const APP_USER_MODEL_ID = 'AgentHuddle.Desktop';
export const PRODUCT_NAME = 'Agent Huddle';

/**
 * The data folder's place under the OS app-data folder: `%APPDATA%\@huddle\desktop`, where it has always been (Electron
 * derived it from the workspace package name `@huddle/desktop`). The packaged app is named `Agent Huddle` by
 * electron-builder's `extraMetadata.name` so its install folder reads `%LOCALAPPDATA%\Programs\Agent Huddle`; without a
 * pin, that rename would also move the data folder, and the installed app would stop sharing history, consent and
 * paired phones with dev (owner decision, M6). main pins it with `app.setPath('userData', …)` before anything reads it.
 */
export const USER_DATA_SEGMENTS = ['@huddle', 'desktop'] as const;

/**
 * The pinned data folder, or null when the caller asked for another one with Chromium's `--user-data-dir` (the M6 exit
 * harness points `--remove-hooks` at a temp folder that way, so it never touches the real consent). Pure.
 */
export function pinnedUserDataPath(
  appData: string,
  hasUserDataDirSwitch: boolean,
  join: (...p: string[]) => string,
): string | null {
  return hasUserDataDirSwitch ? null : join(appData, ...USER_DATA_SEGMENTS);
}
