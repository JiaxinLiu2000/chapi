# Chapi — Local Claude Code Workflow Platform

A **local** web platform that lets you drive **Claude Code** with natural language. You give a task in a web chat; an orchestrating agent plans, calls tools (web research via cloakbrowser, PDF template text-replacement, Google Workspace, Gmail drafts), dispatches and monitors sub-agents, asks you when it's blocked, and shows the whole run live. When you mark a task "brilliantly done", the platform consolidates what it learned into a shared AI wiki for reuse.

> Everything runs locally except outbound API calls (Anthropic, OpenAI, Google, Canva).

## Architecture

- **`apps/web`** — Next.js + React frontend (chat, live monitoring card, wiki/history/settings nav).
- **`apps/server`** — Node/Fastify backend: WebSocket gateway, orchestration **engine** (Claude Agent SDK), in-process & external tools, RAG, persistence, process supervisor.
- **`packages/shared`** — types + the WebSocket event protocol shared by web and server.
- **`workspaces/`** — shared agent areas: `raw-materials/`, `skills/`, `ai-wiki/` (each with an `INDEX.md`).
- **`sessions/<id>/`** — per-session private areas: `memory/`, `sandbox/` (deleted with the session).

See the full design at `~/.claude/plans/` (the approved plan) and `docs/` for module notes.

## Prerequisites

- Node ≥ 20, pnpm ≥ 9
- Docker (for MySQL) **or** a local MySQL 8
- `uv` (for the Python tool sidecars: PyMuPDF/pypdf, cloakbrowser, google_workspace_mcp)
- An Anthropic API key (engine) and OpenAI API key (RAG embeddings)

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in SECRETS_KEY + ANTHROPIC_API_KEY
pnpm db:up                    # start MySQL via docker compose
pnpm db:migrate               # create schema
pnpm dev                      # web on :3100, server on :8123
```

Open http://localhost:3100.

## Status

Built milestone-by-milestone — see the task list / `docs/STATUS.md`.
