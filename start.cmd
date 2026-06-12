@echo off
REM One-click start for Windows: launches DB + backend + frontend.
REM Press Ctrl+C in this window to stop everything (incl. the database).
cd /d "%~dp0"
node scripts\dev.mjs
