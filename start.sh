#!/usr/bin/env bash
# One-click start (macOS/Linux): launches DB + backend + frontend.
# Press Ctrl+C to stop everything (incl. the database).
cd "$(dirname "$0")"
exec node scripts/dev.mjs
