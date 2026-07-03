@echo off
echo ============================================
echo   MCP Orchestrator - Chrome Debug Launcher
echo ============================================
echo.

echo Step 1: Closing existing Chrome instances...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo Step 2: Starting Chrome with debugging port...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir=%~dp0.chrome-debug ^
  https://claude.ai ^
  https://chatgpt.com ^
  https://gemini.google.com

echo Step 3: Waiting for Chrome to start...
timeout /t 5 /nobreak >nul

echo Step 4: Verifying CDP port...
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -UseBasicParsing -TimeoutSec 3; Write-Host 'CDP Port: OK' } catch { Write-Host 'CDP Port: FAILED' }"

echo.
echo ============================================
echo   NEXT STEPS:
echo ============================================
echo 1. Log into all 3 AI sites if needed
echo 2. Restart Claude Desktop to reconnect MCP
echo 3. Run: node tests\run-all.js
echo.
pause
