# Changelog

Version is the single source of truth in `packages/shared/src/version.ts` (`APP_VERSION`),
shown at the bottom of the web UI. **Convention: bump the PATCH (third) digit on every
code update, and use the same `vX.Y.Z` in the commit message.**

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
