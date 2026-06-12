# Build Status

Tracking the milestone-by-milestone build of the Chapi platform.

## Environment notes (this machine)

- Node 24, pnpm 9.15 (installed via npm), uv/uvx 0.11 (for Python sidecars), Docker 29.
- **Port choices** (to avoid a sibling project `chachapi` that occupies 3306 + 8787, and `foodwaste-qdrant` on 6333):
  - MySQL host port: **3307** (container `chapi-mysql`)
  - Server: **8123**
  - Web: **3100**
- ⚠️ A separate running project named **`chachapi`** holds 3306 and 8787. We do not touch or reuse it. If it is actually related to this work, let me know — otherwise we coexist on the ports above.
- Package installs require the sandbox disabled (global/network writes); read-only/typecheck do not.

## Milestones

- [x] **M1 Foundation** — monorepo (pnpm), `@chapi/shared` (domain + WS event protocol + REST contracts), Prisma+MySQL schema (`db push`), config + encrypted settings store, Fastify REST (health/sessions/settings/wiki/uploads), WebSocket gateway + event bus. Verified: health, session CRUD, settings, and a WS round-trip (`run.state` + `assistant.message`) all pass. Engine is a stub (`StubOrchestrator`) pending M2.
- [x] **M2 Engine** — Claude Agent SDK orchestrator: long-lived `Run` per session over streaming input (`query()` with an `AsyncIterable`), SDK messages → ServerEvents + persistence, usage/active-time accounting, `sdkSessionId` capture for resume, `canUseTool` permission enforcement (web sessions write only to sandbox/memory; Gmail send hard-blocked), hook-based monitoring (PreToolUse/PostToolUse/SubagentStart/SubagentStop → agent_runs/tool_calls + TodoWrite→plan_tasks), interrupt. SDK isolation (`settingSources: []`). Verified via a mocked-SDK integration test (assistant message + usage + persistence + main-agent done). **Live run needs `ANTHROPIC_API_KEY`** (env or Settings); absent → graceful error event.
- [x] **M3 Frontend core** — Next.js 15 + React 19 + Tailwind + Zustand + TanStack Query. Home centered chat (creates session → `/s/<slug>`), session page with sticky **monitoring follow-card** (active time / tokens / cost / plan ✅+strikethrough / per-agent status), chat with streaming bubbles, composer (send / upload / interrupt), green "出色完成" button, HITL question/approval dock, top nav (Wiki page / History dropdown with delete-confirm / Settings modal), resilient WS client + event→store pipeline, desktop + toast notifications. `next build` passes (5 routes); dev server serves home/wiki.
- [x] **M4 HITL + monitoring** — in-process SDK MCP server `chapi` with `ask_user` / `request_approval` / `notify_user` / `save_artifact` (zod-v3 shapes; built at runtime in tests). HITL registry blocks the tool call until the user answers/decides in the UI (gateway → `hitl.resolve*`). `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` raised so HITL can block for minutes. Per-agent monitoring uses built-in observable subagents (hooks carry `agent_id`/`agent_type`) → `agent_runs`/`tool_calls`; TodoWrite → `plan_tasks` (✅ / strikethrough-on-vanish). Tests: 5 passing.
- [x] **M5 Workspaces + RAG/Wiki** — shared workspaces (`raw-materials`/`skills`/`ai-wiki`) seeded with `INDEX.md` (purpose + limits) at startup; per-session `memory`/`sandbox` scaffolded on create. RAG: OpenAI embeddings (`text-embedding-3-*`) + embedded **LanceDB** (`wiki_vectors`), multi-index (title + body chunks + agent-supplied alternate questions → same entry). `wiki_write`/`wiki_search` SDK tools + `/wiki/search` REST; frontend Wiki page renders entries + sources. Degrades gracefully without an OpenAI key. Tests: vector nearest-neighbor + wiki upsert (9 total passing).
- [x] **M6 Tool integrations** — **Local PDF** tool (`tools/pdf/pdf_tool.py`, PyMuPDF + pypdf via `uv run --with`): `info` / `replace-text` (redaction-cover + reinsert) / `fill-form`; exposed as `mcp__chapi__pdf_edit` (sandbox-scoped). **Verified live**: make-sample → replace-text → info shows substituted values. **External MCP registry** (gated, off by default): `context7` (docs), `browser` (Playwright MCP → cloakbrowser CDP), `google_workspace` (draft-only; needs OAuth), `canva` (when enabled) — merged into runs; failed/unconfigured degrade gracefully. **Gmail send hard-blocked** (canUseTool heuristic + `disallowedTools`). Skill docs authored (`workspaces/skills/{web-research,pdf-edit,google-workspace}/SKILL.md`), read by the agent (skills dir in `additionalDirectories` + system prompt). Drive delivery via `save_artifact(kind=drive)`. Enabling external tools needs installs/credentials — see env flags. 9 tests passing.
- [x] **M7 Learning loop** — green "出色完成" → `consolidateSession` (one-shot Anthropic call distills 1–4 reusable wiki entries with `sourceRefs`, written via `writeWikiEntry`); 5-round rolling `summarizeSession` → `memory_summaries` + `memory/conversation/`, latest summary injected into the run's system prompt. Session lock (completed = read-only; orchestrator rejects new messages, composer disabled) and delete cascade (DB + memory/sandbox dirs). Degrades gracefully without a key. 9 tests pass.
- [x] **M8 Hardening** — `cloakserve` supervisor (gated by `CHAPI_ENABLE_BROWSER`), `scripts/setup.mjs` (tool checks → .env+SECRETS_KEY → MySQL → schema), `apps/server/scripts/smoke.mjs` (REST + WS e2e), `docs/SETUP.md`. **Fixed a real race**: deleting a session mid-run now `abandon`s the run first + tolerant cleanup (was causing Prisma FK errors). **Final verification: SMOKE PASS with a LIVE agent response** (`run.state → assistant.delta → assistant.message`) — the engine ran end-to-end using this machine's Claude credentials; 9 server tests pass; web build passes.

## ✅ All milestones complete

Live-verified end to end. To run: `node scripts/setup.mjs` (first time) then **`pnpm start`** (one-click) → http://localhost:3100. See `docs/SETUP.md`. Optional external tools (browser/Google/Canva/context7) are gated behind env flags + credentials.

## Post-build refinements

- **One-click launcher** (`pnpm start` / `start.cmd` / `start.sh` → `scripts/dev.mjs`): starts MySQL + backend + frontend with prefixed logs; **Ctrl+C tears down all three** (kills server/web process trees + `docker compose stop`), scoped to Chapi only (leaves other projects' containers alone). Verified: starts everything; teardown commands free :8123/:3100 and stop `chapi-mysql`.
- **No Anthropic key required**: the engine uses this machine's Claude Code credentials; the learning loop's one-shot calls were re-routed from the raw Anthropic API SDK to the Agent SDK `query()` so summaries/consolidation also work without an API key. Settings marks the Anthropic key optional.
- **Drive-first delivery**: system prompt + PDF skill now require uploading final files (incl. PDFs) to Google Drive via `save_artifact(kind=drive)`, falling back to a sandbox path only if Google isn't connected.

## How to run (current)

```bash
pnpm install
pnpm db:up                 # mysql on 3307
cd apps/server && pnpm exec prisma db push   # or: pnpm db:migrate
pnpm --filter @chapi/server start            # http+ws on 8123
```
