@echo off
chcp 65001 >nul
setlocal
title 粘液科技配方树助手
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "E:\Program\NodeJS\node.exe" (
    set "NODE_EXE=E:\Program\NodeJS\node.exe"
  ) else (
    echo [错误] 没有找到 Node.js。
    echo 请先安装 Node.js（https://nodejs.org/），或把 node.exe 放进 PATH。
    pause
    exit /b 1
  )
)

echo 正在启动本地服务，启动后会自动打开浏览器...
echo （端口默认 8791，被占用会自动换端口，请看下面的实际地址）
echo.
set "SF_OPEN_URL=1"
"%NODE_EXE%" "tools\serve.mjs"

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
