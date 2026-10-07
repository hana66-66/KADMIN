@echo off
chcp 65001 >nul
rem ============================================================
rem  重新编译 KADMIN 开发者面板（.cs → .exe）
rem  用 Windows 自带的 .NET Framework C# 编译器（csc.exe），不需要装任何东西
rem ============================================================
setlocal
set HERE=%~dp0
set SRC=%HERE%KADMIN开发者面板.cs
set OUT=%HERE%KADMIN开发者面板.exe

set CSC=
for %%P in (
  "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) do if not defined CSC if exist %%P set CSC=%%~P

if not defined CSC (
  echo [错误] 找不到 csc.exe（.NET Framework 4.x 自带的 C# 编译器）
  pause
  exit /b 1
)

echo 用 %CSC% 编译...
"%CSC%" /nologo /utf8output /target:winexe /out:"%OUT%" ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Core.dll ^
  "%SRC%"

if exist "%OUT%" (
  echo.
  echo [完成] 已生成 %OUT%
) else (
  echo.
  echo [失败] 编译没通过，请看上面的报错
)
echo.
pause
endlocal
