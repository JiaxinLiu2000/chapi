import path from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionProfile } from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('permissions');

/** Tools that write to the filesystem; their target path must be inside allowed dirs. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Returns true if `child` is the same as or inside `parent`. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function looksLikeGmailSend(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return n.includes('send') && (n.includes('gmail') || n.includes('mail') || n.includes('message'));
}

/**
 * Build the per-session permission callback.
 * - `vscode` profile: full access.
 * - `web` profile: file writes confined to the session sandbox + memory; Gmail
 *   send hard-blocked (defense in depth alongside disallowedTools).
 */
export function buildCanUseTool(
  sessionId: string,
  profile: PermissionProfile,
): CanUseTool {
  const sp = sessionPaths(sessionId);
  const writableRoots = [sp.sandbox, sp.memory];

  return async (toolName, input) => {
    // Gmail send is never allowed, regardless of profile.
    if (looksLikeGmailSend(toolName)) {
      log.warn(`blocked gmail-send-like tool: ${toolName}`);
      return { behavior: 'deny', message: 'Sending email is disabled. Create a draft instead.' };
    }

    if (profile === 'vscode') {
      return { behavior: 'allow' };
    }

    // web profile: restrict file-writing tools to the session's private dirs.
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const target = (input.file_path ?? input.path ?? input.notebook_path) as
        | string
        | undefined;
      if (typeof target === 'string') {
        const abs = path.isAbsolute(target) ? target : path.resolve(sp.sandbox, target);
        const allowed = writableRoots.some((root) => isInside(abs, root));
        if (!allowed) {
          return {
            behavior: 'deny',
            message:
              `Web sessions may only write inside the session sandbox (${sp.sandbox}) ` +
              `or memory (${sp.memory}). Refused path: ${abs}`,
          };
        }
      }
    }

    return { behavior: 'allow' };
  };
}

/** Tool names disallowed entirely for a profile (removed from the model's context). */
export function disallowedToolsFor(profile: PermissionProfile): string[] {
  if (profile === 'vscode') return [];
  // Defense in depth: remove known Gmail send tools from context entirely.
  // canUseTool also blocks any send-like tool name at call time.
  return [
    'mcp__google_workspace__send_gmail_message',
    'mcp__google_workspace__send_message',
    'mcp__google_workspace__reply_to_gmail_message',
  ];
}
