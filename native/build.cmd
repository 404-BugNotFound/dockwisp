@echo off
setlocal
set ROOT=%~dp0
if not exist "%ROOT%bin" mkdir "%ROOT%bin"
if not exist "%ROOT%obj" mkdir "%ROOT%obj"

set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if not exist "%VSWHERE%" (
  echo Visual Studio Build Tools not found.
  exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSROOT=%%i
if not defined VSROOT (
  echo MSVC x64 toolchain not found.
  exit /b 1
)

call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
cl.exe /nologo /std:c++20 /O2 /EHsc /MT /DUNICODE /D_UNICODE "%ROOT%src\mouse_hook.cpp" /Fo:"%ROOT%obj\mouse_hook.obj" /Fe:"%ROOT%bin\mouse-hook.exe" /link user32.lib gdi32.lib ole32.lib oleaut32.lib uiautomationcore.lib dwmapi.lib
if errorlevel 1 exit /b %errorlevel%
cl.exe /nologo /std:c++20 /O2 /EHsc /MT /DUNICODE /D_UNICODE "%ROOT%src\everything_search.cpp" /Fo:"%ROOT%obj\everything_search.obj" /Fe:"%ROOT%bin\everything-search.exe" /link shell32.lib "%ROOT%sdk\Everything64.lib"
if errorlevel 1 exit /b %errorlevel%
copy /y "%ROOT%sdk\Everything64.dll" "%ROOT%bin\Everything64.dll" >nul
exit /b %errorlevel%
