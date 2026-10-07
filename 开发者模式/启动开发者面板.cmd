@echo off
chcp 65001 >nul
rem ============================================================
rem  KADMIN 开发者模式 · 启动面板（独立 exe，本地窗口）
rem  前置：先在浏览器里打开 开发\KADMIN-卡兹铭刻.html（保持开着）
rem  说明：面板是原生 Windows 窗口，内置 127.0.0.1:7788 服务，游戏会自己连上来
rem ============================================================
setlocal
set EXE=%~dp0KADMIN开发者面板.exe
if not exist "%EXE%" (
  echo [错误] 找不到 KADMIN开发者面板.exe
  echo         先双击「重新编译面板.cmd」生成它（需要系统自带的 csc.exe，无需安装任何东西）。
  echo.
  pause
  exit /b 1
)
echo [KADMIN 开发者面板] 正在打开本地窗口...
start "" "%EXE%"
echo.
echo 面板显示「○ 离线」时依次检查：
echo   1) KADMIN 游戏已经在浏览器里打开过（本版产物自带开发者桥）
echo   2) 面板与游戏在**同一台机器**（走 127.0.0.1，不经过网络）
echo   3) 稍等 1~4 秒（游戏每 0.5 秒来取一次命令，面板没开时会退避到 4 秒）
echo.
timeout /t 5 >nul
endlocal
