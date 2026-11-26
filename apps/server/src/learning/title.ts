import { prisma } from '../db/client.js';
import { complete } from '../engine/llm.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { classifySession } from '../board/classify.js';
import { toSessionDTO } from '../mappers.js';

const log = createLogger('learning:title');

/**
 * Display-width budget for a title, so it fits on one line of the history list
 * without being cut off: CJK/full-width chars count 2, everything else 1.
 * 36 ≈ 18 汉字 or ~36 Latin chars at text-sm in the 384px history panel.
 */
export const TITLE_MAX_WIDTH = 36;

const isWide = (ch: string) =>
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(
    ch,
  );

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += isWide(ch) ? 2 : 1;
  return w;
}

/** A model reply as a bare one-line title: first non-empty line, no "标题：" prefix, no wrapping quotes, no trailing period. */
export function tidyTitle(raw: string): string {
  let t = (raw.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();
  t = t.replace(/^(标题|title)\s*[:：]\s*/i, '');
  t = t.replace(/^[\s"'“”‘’「」『』《》【】`*#]+|[\s"'“”‘’「」『』《》【】`*。．.！!；;，,、]+$/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * tidyTitle, then — only as a last resort when the model keeps overshooting —
 * cut at the width budget (at a word boundary for Latin text), never with an ellipsis.
 */
export function cleanTitle(raw: string): string {
  const t = tidyTitle(raw);
  if (displayWidth(t) <= TITLE_MAX_WIDTH) return t;
  let out = '';
  for (const ch of t) {
    if (displayWidth(out + ch) > TITLE_MAX_WIDTH) break;
    out += ch;
  }
  // Mid-word cut in Latin text → back off to the last space.
  const next = t.slice(out.length, out.length + 1);
  if (/[A-Za-z0-9]$/.test(out) && /[A-Za-z0-9]/.test(next) && out.includes(' ')) {
    out = out.slice(0, out.lastIndexOf(' '));
  }
  return out.replace(/[\s\-–—:：,，、]+$/, '');
}

/**
 * Write a title without bumping `updatedAt`. The history list is ordered by
 * updatedAt, and Prisma's @updatedAt would otherwise move a session to the top
 * (or every backfilled one to "今天") just because its title changed.
 */
export async function setTitleKeepingOrder(
  sessionId: string,
  title: string,
  source: 'auto' | 'ai' | 'user',
  opts: { unlessUser?: boolean } = {},
): Promise<number> {
  return opts.unlessUser
    ? prisma.$executeRaw`UPDATE \`Session\` SET title = ${title}, titleSource = ${source} WHERE id = ${sessionId} AND titleSource <> 'user'`
    : prisma.$executeRaw`UPDATE \`Session\` SET title = ${title}, titleSource = ${source} WHERE id = ${sessionId}`;
}

const inFlight = new Set<string>();

/**
 * Give a session a short AI-written title summarizing what it's about. Never
 * touches a title the user set themselves (titleSource 'user'). Fire-and-forget:
 * failures just leave the current title in place.
 */
export async function generateSessionTitle(sessionId: string): Promise<void> {
  if (inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  try {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.titleSource === 'user') return;

    const messages = await prisma.message.findMany({
      where: { sessionId, role: { in: ['user', 'assistant'] }, type: { in: ['user', 'assistant'] }, NOT: { text: '' } },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: { role: true, text: true },
    });
    if (!messages.some((m) => m.role === 'user')) return;
    // User turns carry the intent; keep assistant replies short so they add
    // context without drowning it.
    const transcript = messages
      .map((m) => (m.role === 'user' ? `用户: ${m.text.slice(0, 1500)}` : `AI: ${m.text.slice(0, 300)}`))
      .join('\n')
      .slice(0, 8000);

    const english = session.language === 'en';
    const ask = (prompt: string) =>
      complete({
        system: english
          ? 'You write titles for chat history entries. Reply with the title only.'
          : '你为对话历史列表起标题。只输出标题本身。',
        prompt,
        model: session.subagentModel || session.model || undefined,
        accountMode: (session.accountMode as 'auto' | 'primary' | 'fallback') || undefined,
        sessionId,
        trigger: 'title',
      });
    const budget = english
      ? `at most ${TITLE_MAX_WIDTH} characters`
      : `不超过 ${TITLE_MAX_WIDTH / 2} 个汉字（英文字母、数字、空格每个按半个汉字算）`;

    // It has to fit on one line uncut, so when the model overshoots, hand the
    // title back and ask for a shorter one instead of chopping it.
    // Transcript first, instruction last: with the instruction up front, a
    // conversation that ends mid-argument tempts the model to reply to it.
    let title = tidyTitle(
      await ask(
        english
          ? `<conversation>\n${transcript}\n</conversation>\n\nAbove is a conversation log. You are not part of it — do not reply to or continue it. Write a title (${budget}, no quotes, no trailing period) that summarizes what the conversation is about: the task itself, not "User asks…". Reply with the title only.`
          : `<对话>\n${transcript}\n</对话>\n\n以上是一段对话记录。你不是对话中的任何一方，不要回应或接着它说。用${budget}概括这段对话在做什么，作为历史记录标题：直接写任务本身，不要「用户想要…」之类的开头，不要引号和句号。只输出标题。`,
      ),
    );
    for (let retry = 0; retry < 2 && displayWidth(title) > TITLE_MAX_WIDTH; retry++) {
      title = tidyTitle(
        await ask(
          english
            ? `"${title}" is too long. Rewrite it as a complete title of ${budget} — drop minor words rather than cutting one off. Reply with the title only.`
            : `「${title}」太长了。改写成${budget}的完整标题——宁可省掉次要的词（比如具体工具名），也不要写半截。只输出标题。`,
        ),
      );
    }
    title = cleanTitle(title);
    if (!title) return;

    // Re-check: the user may have renamed while the model was thinking.
    const count = await setTitleKeepingOrder(sessionId, title, 'ai', { unlessUser: true });
    if (count === 0) return;
    const updated = await prisma.session.findUnique({ where: { id: sessionId } });
    if (updated) bus.emit({ type: 'session.updated', session: toSessionDTO(updated) });
    log.info(`titled session ${sessionId}: ${title}`);
    void classifySession(sessionId).catch(() => {});
  } catch (err) {
    log.warn(`title generation failed for ${sessionId}`, err);
  } finally {
    inFlight.delete(sessionId);
  }
}
