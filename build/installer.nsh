; Custom NSIS hooks for Dockwisp.
;
; Dockwisp runs the portable Everything from a writable copy under the current
; user's roaming AppData (%APPDATA%\Dockwisp\everything). That copy is a program,
; not user data, so a real uninstall must stop and delete it. During an in-app
; update electron-builder silently runs the OLD uninstaller with the --updated
; flag (see app-builder-lib installUtil.nsh), which makes ${isUpdated} true; in
; that case we must leave the running copy alone so the upgrade does not need to
; stop Everything.

!macro customUnInstall
  ; Only act on a genuine uninstall, never during an update's silent uninstall.
  ${ifNot} ${isUpdated}
    ; The installer is per-machine, so $APPDATA may resolve to the all-users
    ; context. Switch to the current user's roaming AppData to find the copy.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    StrCpy $0 "$APPDATA\${APP_FILENAME}\everything"

    ; Stop only the Everything process whose image lives in that exact folder,
    ; never a system-installed Everything. PowerShell filters by ExecutablePath;
    ; a trailing backslash keeps the match inside the folder. Failure is ignored
    ; (the folder removal below still runs).
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$0\', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $1
    DetailPrint "Stopped portable Everything in $0 (code $1)"

    ; Give the process a moment to release its files, then remove the folder.
    Sleep 500
    RMDir /r "$0"
    DetailPrint "Removed portable Everything folder $0"

    ; Restore the all-users context the rest of the uninstaller expects.
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
