; Agent Huddle NSIS additions (M6 P6), included by electron-builder (electron-builder.json nsis.include).
;
; The uninstaller never edits Claude Code's settings (~/.claude/**) itself: only the app may change them (ADR-014).
; It asks whether to run the app's own full clean-up, "Agent Huddle.exe" --remove-hooks (hooks, telemetry settings,
; status line bridge, self-report MCP server, remembered consent), and runs it when the user says Yes (the default),
; before any file is removed. Without it, Claude Code would keep exporting telemetry to a port nothing owns.
; A silent uninstall skips the clean-up (the clean-up shows its own result dialog, which would block); run
; --remove-hooks first in that case. It also removes what the app put in the registry for "Start Agent Huddle when
; Windows starts" (login-item.ts). The app data folder (%APPDATA%) is kept (nsis.deleteAppDataOnUninstall is false).
;
; Both macros skip their work when the uninstaller runs as part of an update or reinstall (${isUpdated}).

!macro customUnInit
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "Remove Agent Huddle's settings from Claude Code too?$\r$\n$\r$\nYes (recommended): removes the hooks, telemetry settings, status line bridge and self-report server it added, so Claude Code runs exactly as before. Quit Agent Huddle from the tray first.$\r$\n$\r$\nNo: uninstall the app only.$\r$\n$\r$\nYour Agent Huddle data folder is kept either way." /SD IDNO IDYES huddle_clean IDNO huddle_uninstall_ok
    Abort
    huddle_clean:
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-hooks' $0
      ; A failed clean-up (most often: Agent Huddle is still running) stops the uninstall, so the app is never removed
      ; while Claude Code's settings still point at it. The clean-up has already said why in its own dialog.
      StrCmp $0 "0" huddle_uninstall_ok
      MessageBox MB_OK|MB_ICONEXCLAMATION "The clean-up did not finish, so nothing was uninstalled.$\r$\n$\r$\nQuit Agent Huddle from the tray, then run the uninstaller again." /SD IDOK
      Abort
    huddle_uninstall_ok:
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The login item Electron writes (app.setLoginItemSettings, value named after the AppUserModelID).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AgentHuddle.Desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "AgentHuddle.Desktop"
  ${endIf}
!macroend
