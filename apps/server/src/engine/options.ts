import type { Session } from '@prisma/client';
import type {
  CanUseTool,
  EffortLevel,
  HookCallbackMatcher,
  HookEvent,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type { Language, PermissionProfile } from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { disallowedToolsFor } from './permissions.js';
import { buildSystemPrompt } from './systemPrompt.js';

export interface BuildOptionsDeps {
  canUseTool: CanUseTool;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  anthropicKey?: string;
  mcpServers?: Options['mcpServers'];
  allowedTools?: string[];
  extraSystemContext?: string | null;
  maxSubagents?: number;
  abortController: AbortController;
}

/**
 * Assemble the `query()` options for a session run. Uses SDK isolation
 * (`settingSources: []`) so the platform agent does NOT inherit the user's
 * personal ~/.claude config — only what we pass here.
 */
export function buildRunOptions(session: Session, deps: BuildOptionsDeps): Options {
  const sp = sessionPaths(session.id);
  const profile = session.permissionProfile as PermissionProfile;

  // Sub-agent model: only override the built-in general-purpose agent when the
  // session's sub-agent model differs from the main model — otherwise inherit the
  // SDK's default (best behavior). AgentDefinition.model applies to Task workers.
  const subModel = (session.subagentModel || '').trim();
  const agents: Options['agents'] | undefined =
    subModel && subModel !== session.model
      ? {
          'general-purpose': {
            description:
              'General-purpose subagent for delegated tasks (research, browsing, batch scripts, file ops).',
            prompt:
              '你是被主代理派发来独立完成一个具体子任务的通用子代理。自主、彻底地完成任务（可用全部工具），完成后用简洁要点回报结果与产出位置。',
            model: subModel, // run sub-agents on the session's chosen sub-agent model
          },
        }
      : undefined;

  return {
    model: session.model,
    ...(agents ? { agents } : {}),
    effort: session.effort as EffortLevel,
    cwd: sp.sandbox,
    additionalDirectories: [
      sp.memory,
      config.paths.rawMaterials,
      config.paths.skills,
      config.paths.aiWiki,
    ],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildSystemPrompt(
        session.id,
        profile,
        deps.extraSystemContext,
        deps.maxSubagents,
        session.language as Language,
      ),
    },
    canUseTool: deps.canUseTool,
    hooks: deps.hooks,
    allowedTools: deps.allowedTools,
    disallowedTools: disallowedToolsFor(profile),
    permissionMode: 'default',
    includePartialMessages: true,
    agentProgressSummaries: true,
    settingSources: [],
    mcpServers: deps.mcpServers ?? {},
    abortController: deps.abortController,
    ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
    env: {
      ...process.env,
      // HITL tools (ask_user/request_approval) can block for minutes while the
      // user responds; keep the SDK MCP stream open well beyond the 60s default.
      CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '3600000',
      // CDP endpoint of the running cloakbrowser — used by the chapi_browser.py
      // helper so the agent's scripts attach to the shared stealth browser.
      CHAPI_CDP_ENDPOINT: `http://127.0.0.1:${config.cloakbrowserCdpPort}`,
      // Force UTF-8 for the agent's Python scripts so non-ASCII output (e.g. the
      // "→" arrow, Chinese) doesn't crash on the Windows cp1252 console.
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(deps.anthropicKey ? { ANTHROPIC_API_KEY: deps.anthropicKey } : {}),
    },
  };
}
