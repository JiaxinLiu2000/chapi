import type { ContentBlock } from '@chapi/shared';

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Convert an Anthropic message's content into our ContentBlock[] + flattened text. */
export function extractContent(message: unknown): { blocks: ContentBlock[]; text: string } {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') {
    return { blocks: [{ type: 'text', text: content }], text: content };
  }
  const blocks: ContentBlock[] = [];
  let text = '';
  if (Array.isArray(content)) {
    for (const raw of content as RawBlock[]) {
      switch (raw?.type) {
        case 'text':
          blocks.push({ type: 'text', text: raw.text ?? '' });
          text += raw.text ?? '';
          break;
        case 'thinking':
          blocks.push({ type: 'thinking', text: raw.thinking ?? '' });
          break;
        case 'tool_use':
          blocks.push({
            type: 'tool_use',
            id: raw.id ?? '',
            name: raw.name ?? '',
            input: raw.input,
          });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            toolUseId: raw.tool_use_id ?? '',
            content:
              typeof raw.content === 'string'
                ? raw.content
                : JSON.stringify(raw.content ?? ''),
            isError: raw.is_error,
          });
          break;
        default:
          break;
      }
    }
  }
  return { blocks, text };
}

/** Short single-line preview of arbitrary tool input/output for monitoring. */
export function preview(value: unknown, max = 300): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
