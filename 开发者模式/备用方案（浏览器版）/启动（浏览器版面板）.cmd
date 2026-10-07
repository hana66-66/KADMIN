@echo off
chcp 65001 >nul
rem ============================================================
rem  KADMIN 开发者模式 · 启动器
rem  打开外挂面板（小窗口）。优先用 Edge/Chrome 的「应用窗口」模式：
rem     --app=... --window-size=520,820   → 没有地址栏/标签栏的小窗，可以钉在游戏旁边
rem  找不到 Edge/Chrome 时退回系统默认浏览器（普通标签页）。
rem  前置：先在**同一个浏览器**里打开 开发\KADMIN-卡兹铭刻.html（保持开着）。
rem ============================================================
setlocal enabledelayedexpansion
set HERE=%~dp0
set PANEL=%HERE%KADMIN 开发者模式.html
set GAME=%HERE%..\KADMIN-卡兹铭刻.html
set PANELURL=file:///%PANEL:\=/%
set PANELURL=%PANELURL: =%%20%

echo [KADMIN 开发者模式]
echo   面板：%PANEL%
echo   游戏：%GAME%
echo.

set BROWSER=
for %%P in (
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if not defined BROWSER if exist %%P set BROWSER=%%~P
)

if defined BROWSER (
  echo 正在用小窗口模式打开面板（%BROWSER%）...
  start "" "%BROWSER%" --app="%PANELURL%" --window-size=520,820 --window-position=80,80
) else (
  echo 没找到 Edge/Chrome，改用系统默认浏览器（普通标签页）打开...
  start "" "%PANEL%"
)

echo.
echo 面板显示「未连接」时依次检查：
echo   1) KADMIN 游戏已经在浏览器里打开（本版产物自带开发者桥）
echo   2) 面板与游戏是**同一个浏览器**（Edge 开的游戏就用 Edge 开面板）
echo   3) 点一下面板右上角「刷新状态」
echo.
timeout /t 6 >nul
endlocal
