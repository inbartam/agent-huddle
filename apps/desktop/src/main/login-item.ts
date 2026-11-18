/**
 * "Start Agent Huddle when Windows starts" (M6 P6), off by default. Electron writes a value under
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run (and its StartupApproved twin, which Task Manager's Startup apps
 * toggles) named after the AppUserModelId; a per-user install needs no admin rights for HKCU. The value is the
 * installed exe with no arguments, so a start at sign-in is an ordinary start (widget shown, main window in the tray).
 *
 * Only offered in a packaged Windows build: in a dev run `process.execPath` is node_modules' electron.exe, which would
 * open Electron's default app at every sign-in. The NSIS uninstaller deletes both registry values (installer.nsh).
 */
export interface LoginItemApi {
  /** Windows reads the value named after the AppUserModelID set at start (the same name `set` writes). */
  getLoginItemSettings(options: { path: string; args: string[] }): {
    openAtLogin: boolean;
    executableWillLaunchAtLogin?: boolean;
  };
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    path: string;
    args: string[];
    name: string;
    enabled: boolean;
  }): void;
}

export interface LoginItemEnv {
  packaged: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  appUserModelId: string;
}

export function createLoginItem(api: LoginItemApi, e: LoginItemEnv): { get(): boolean; set(on: boolean): void } | null {
  if (!e.packaged || e.platform !== 'win32') return null;
  const target = { path: e.execPath, args: [] as string[], name: e.appUserModelId };
  return {
    // Off when the run key exists but Task Manager disabled it: Windows will not start the app.
    get: () => {
      const s = api.getLoginItemSettings({ path: target.path, args: target.args });
      return s.openAtLogin && s.executableWillLaunchAtLogin !== false;
    },
    // `enabled` also clears a Task Manager "Disabled", so turning the switch on always means "starts at sign-in".
    set: (on) => {
      api.setLoginItemSettings({ ...target, openAtLogin: on, enabled: on });
    },
  };
}
