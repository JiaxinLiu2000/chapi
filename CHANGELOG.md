# Changelog

Version is the single source of truth in `packages/shared/src/version.ts` (`APP_VERSION`),
shown at the bottom of the web UI. **Convention: bump the PATCH (third) digit on every
code update, and use the same `vX.Y.Z` in the commit message.**

## v0.1.7

- Fix: Google Workspace now **auto-enables when OAuth credentials are set in Settings** —
  no separate `CHAPI_ENABLE_GOOGLE` env flag needed. This is why no OAuth consent popup
  appeared and the agent had no Google tools. The first Google tool call triggers consent.
- Fix: web tools failing ("harness-level permission error"). `allowedTools` was narrowed to
  only the 7 in-process tools, forcing WebSearch/WebFetch/Task/etc. through the permission
  path. Now built-in safe tools (Read/Grep/Glob/TodoWrite/Task/WebSearch/WebFetch) are
  pre-approved; writes + external MCP tools still go through canUseTool. **Verified live:**
  WebFetch on example.com returns "Example Domain".
- Add **max parallel sub-agents** setting (1–8, default 3), enforced via the system prompt
  and surfaced in Settings.
- UI: stop rendering empty message bubbles (tool-only/empty assistant turns).
- Resilience: vector search degrades to empty on a dimension mismatch instead of throwing.
- canUseTool now returns `updatedInput` on allow (correct SDK contract).

## v0.1.6

- Fix "Failed to fetch" when sending a message: CORS now reflects any origin (the server
  binds to loopback, so this is safe locally), fixing the case where the web is opened via a
  LAN URL (e.g. http://192.168.x.x:3100) or a non-default port. Verified the API returns 201
  with `access-control-allow-origin` echoing a LAN origin.
- The web now shows an actionable error ("无法连接后端 … 请确认后端已启动 pnpm start") instead of a
  bare "Failed to fetch" when the backend is unreachable.

## v0.1.5

- Fix: stale production `.next` cache (from `next build`) crashed `next dev` with
  "Cannot find module './NNN.js'". The launcher now detects a leftover production build
  (`.next/BUILD_ID`) and clears `apps/web/.next` before starting dev. Verified `/` and
  `/wiki` render 200 with a fresh cache.

## v0.1.4

- Settings: saved secret fields (OpenAI key, Google OAuth Client ID & Secret) now show a
  green **已保存** badge next to the label and the input shows only dots (masked), instead of
  text placeholders. Client ID is masked like the Secret.

## v0.1.3

- Settings: add a **Google account email** field (passed as `USER_GOOGLE_EMAIL` to the
  Google Workspace MCP so the agent operates as that account); seeded to
  `joannaliubus@gmail.com` in env defaults.
- Settings: **remove the Anthropic API Key field** — the engine uses this machine's
  Claude Code credentials.
- Settings: **main/sub-agent model are now dropdowns** (from `MODEL_OPTIONS`) instead of
  free-text inputs.

## v0.1.2

- Per-session **model and effort selectors** in the session UI (top config bar), with live
  switching: model changes apply immediately via `query.setModel()`; effort changes apply on
  the next message (run restarts with `resume` to preserve context). Both persist on the session.

## v0.1.1

- Cloud-first delivery: prefer generating documents/sheets directly in Google Workspace
  and designs/PDFs in Canva; the session sandbox is only a temporary/fallback workspace.
  Final results land on Google Drive (`save_artifact(kind=drive|doc|sheet)`).
- No Anthropic API key required: the engine uses this machine's Claude Code credentials,
  and the learning loop's one-shot calls were re-routed through the Agent SDK `query()`.
- One-click launcher (`pnpm start` / `start.cmd` / `start.sh`) starts MySQL + backend +
  frontend and tears all three down on Ctrl+C.
- Version shown at the bottom of every page.

## v0.1.0

- Initial full build (M1–M8): monorepo, shared protocol, MySQL+Prisma, Fastify REST +
  WebSocket gateway; Claude Agent SDK engine (streaming, resume, canUseTool permissions,
  interrupt, hook-based monitoring); Next.js frontend (chat, monitoring card, nav, wiki);
  HITL tools; 5 workspaces; OpenAI + LanceDB RAG/wiki; local PDF tool + gated external MCPs
  (cloakbrowser/Google/Canva/context7); learning loop; setup/smoke scripts.
