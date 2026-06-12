# Chapi — Setup & Operations

Local-only platform that drives Claude Code from a web UI. Everything runs on your
machine except outbound API calls (Anthropic, OpenAI, Google, Canva).

## Prerequisites

| Tool | Why |
|------|-----|
| Node ≥ 20, pnpm ≥ 9 | web + server |
| Docker | MySQL (or use a local MySQL 8) |
| uv | Python tool sidecars (local PDF, cloakbrowser, google_workspace_mcp) |
| Anthropic API key | the orchestration engine |
| OpenAI API key | RAG embeddings (optional but recommended) |

## Ports (chosen to avoid clashes with a sibling `chachapi` project on this machine)

- MySQL host port **3307** (container `chapi-mysql`)
- Server **8123**
- Web **3100**

> ⚠️ A separate running project `chachapi` occupies 3306 + 8787 here. Chapi avoids those.
> If `chachapi` is actually related to this work, say so — otherwise they coexist.

## Quick start

```bash
node scripts/setup.mjs      # checks tools, writes .env (+SECRETS_KEY), starts MySQL, pushes schema
pnpm dev                    # web → http://localhost:3100 , server → http://localhost:8123
```

Open http://localhost:3100, click **Settings (⚙)**, and add your **Anthropic** key
(required) and **OpenAI** key (for the wiki/RAG). Then describe a task on the home screen.

Manual setup (equivalent):
```bash
pnpm install
cp .env.example .env          # then set SECRETS_KEY + ANTHROPIC_API_KEY
pnpm db:up                    # MySQL on 3307
cd apps/server && pnpm exec prisma db push
pnpm dev
```

## API keys

Set in the **Settings UI** (stored AES-256-GCM encrypted in MySQL) or in `.env`.
- `ANTHROPIC_API_KEY` — engine. (If you already use Claude Code on this machine, the SDK
  can pick up those credentials automatically.)
- `OPENAI_API_KEY` — embeddings for the AI Wiki / RAG. Without it, wiki search degrades to empty.

## Optional tool integrations (off by default — set the flag, then restart the server)

| Capability | Enable | Extra setup |
|---|---|---|
| **Docs lookup** (context7) | `CHAPI_ENABLE_CONTEXT7=1` | none (npx) |
| **Web search/scrape** (cloakbrowser via Playwright MCP) | `CHAPI_ENABLE_BROWSER=1` | `pip install cloakbrowser && python -m cloakbrowser install`; server runs `cloakserve` on :9222; **log in once** in the controlled browser to persist sessions |
| **Google Workspace** (Docs/Sheets/Drive/Gmail **drafts**) | `CHAPI_ENABLE_GOOGLE=1` | create a Google OAuth client, paste Client ID/Secret in Settings; first run does OAuth in the browser. **Gmail send is hard-blocked.** |
| **Canva** (from-scratch design → PDF) | toggle in Settings | OAuth via Canva on first use |
| **Local PDF** (template text-replace / form-fill) | always on | needs `uv` (auto-installs pymupdf/pypdf on first call) |

## Verify

```bash
pnpm --filter @chapi/server test           # unit/integration (mocked SDK + DB + vectors)
node apps/server/scripts/smoke.mjs 8123     # REST + WS pipeline end-to-end
pnpm --filter @chapi/web build              # frontend type-check + build
```

## How it works (one paragraph)

The server runs one long-lived `query()` (Claude Agent SDK) per session over a streaming
input queue. SDK messages become live `ServerEvent`s over WebSocket; hooks
(`PreToolUse`/`PostToolUse`/`SubagentStart`/`SubagentStop`, carrying `agent_id`) drive the
monitoring card; an in-process MCP server (`chapi`) provides `ask_user` / `request_approval`
/ `notify_user` / `save_artifact` / `wiki_search` / `wiki_write` / `pdf_edit`. Permissions
are enforced in `canUseTool` (web sessions write only to the session sandbox/memory; Gmail
send blocked). MySQL stores sessions/messages/plan/agents/artifacts/wiki metadata; LanceDB
stores embeddings. The green button distills the session into the AI Wiki.
