@echo off
rem Startet die MCP-SQL-Proxy-App eigenstaendig (ohne Claude-Session / MCP-Server).
rem Laeuft schon eine Instanz, holt der Single-Instance-Lock nur das vorhandene Fenster nach vorn.
set "ROOT=%~dp0"
if not exist "%ROOT%dist\electron\main.js" (
  echo dist\electron\main.js fehlt - bitte zuerst "npm run build" ausfuehren.
  pause
  exit /b 1
)
start "MCP SQL Proxy" /D "%ROOT%" "%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%dist\electron\main.js"
