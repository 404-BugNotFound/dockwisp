; Custom NSIS hooks for Dockwisp.
;
; Dockwisp keeps programs it fetches at runtime under the current user's
; roaming AppData (%APPDATA%\Dockwisp):
;   everything\  writable copy of the portable Everything
;   engines\     downloaded conversion engines (LibreOffice, pdf2docx/Python)
; These are programs, not user data, so a real uninstall stops and deletes
; them. Settings, plugins and history in the same folder are removed only when
; the user agrees (silent uninstalls keep them).
;
; During an in-app update electron-builder silently runs the OLD uninstaller
; with the --updated flag (see app-builder-lib installUtil.nsh), which makes
; ${isUpdated} true; in that case nothing here runs, so the upgrade neither
; stops Everything nor drops the downloaded engines.

!macro customUnInstall
  ; Only act on a genuine uninstall, never during an update's silent uninstall.
  ${ifNot} ${isUpdated}
    ; The installer is per-machine, so $APPDATA may resolve to the all-users
    ; context. Switch to the current user's roaming AppData to find the data.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    StrCpy $0 "$APPDATA\${APP_FILENAME}"

    ; Stop only processes whose image lives inside that folder (the portable
    ; Everything, soffice, the embedded Python), never a system-installed copy.
    ; PowerShell filters by ExecutablePath; a trailing backslash keeps the
    ; match inside the folder. Failure is ignored (the removal below still runs).
    nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$0\', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $1
    DetailPrint "Stopped Dockwisp helper processes in $0 (code $1)"

    ; Give the processes a moment to release their files, then remove them.
    Sleep 500
    RMDir /r "$0\everything"
    DetailPrint "Removed portable Everything folder $0\everything"
    RMDir /r "$0\engines"
    DetailPrint "Removed downloaded conversion engines $0\engines"

    ; Settings, plugins and history: ask, defaulting to keep. /SD IDNO keeps
    ; them on a silent uninstall.
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除 Dockwisp 的设置、插件和使用记录？$\r$\n$\r$\n选择“否”会保留这些数据，重新安装后可以继续使用。$\r$\n位置：$0" /SD IDNO IDNO dockwispKeepUserData
      RMDir /r "$0"
      DetailPrint "Removed Dockwisp user data $0"
    dockwispKeepUserData:

    ; Restore the all-users context the rest of the uninstaller expects.
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
