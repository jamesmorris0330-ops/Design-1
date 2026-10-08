@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 from https://nodejs.org and reopen this launcher.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) === 24 ? 0 : 1)"
if errorlevel 1 (
  echo THE EXPERIMENT requires Node.js 24. Install that version and try again.
  pause
  exit /b 1
)
if not exist "dist-server\index.js" (
  echo Extract the complete release ZIP before running this launcher.
  pause
  exit /b 1
)
if not exist "node_modules\fastify\package.json" (
  echo Installing game dependencies. Internet access is needed for this first launch.
  call npm.cmd ci --omit=dev --cache "%~dp0.npm-cache" --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your Internet connection and try again.
    pause
    exit /b 1
  )
)
set "NODE_ENV=development"
set "PUBLIC_ORIGIN="
set "TRUST_PROXY="
set "HOST=0.0.0.0"
if not defined PORT set "PORT=3000"
set "DATABASE_PATH=%~dp0data\experiment.sqlite"
echo THE EXPERIMENT will run on this PC, port %PORT%.
echo Keep this window open while playing. See docs\pc-quick-start.md for phone access.
call npm.cmd start
if errorlevel 1 (
  echo The server stopped with an error. Check the message above.
  pause
  exit /b 1
)
