import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';

/**
 * Emit a cross-session "attention" alert (delivered to all clients) so a
 * background session's question/approval/completion pops a notification even
 * when the user is viewing another conversation.
 */
export async function emitAttention(
  sessionId: string,
  kind: 'question' | 'approval' | 'notify',
  body: string,
): Promise<void> {
  const s = await prisma.session
    .findUnique({ where: { id: sessionId }, select: { slug: true, title: true } })
    .catch(() => null);
  if (!s) return;
  bus.emit({ type: 'session.attention', sessionId, slug: s.slug, title: s.title, kind, body });
}
