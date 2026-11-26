import { prisma } from '../db/client.js';
import { workflowEngine } from './engine.js';
import { matchSops } from './match.js';

/**
 * Route requests that name a confirmed SOP into `workflow_start` (spec §5.1). The system
 * prompt's catalog alone is not enough: in a long conversation the main AI follows its
 * old habits (seen 2026-11-23: "更新project tracker" → a hand-written set_plan).
 *  - every user message is matched; a hit gets an explicit instruction appended;
 *  - the first set_plan after such a hit is bounced once (the user may still say "不按 SOP").
 */

const pending = new Map<string, { slug: string; name: string }[]>();

export async function sopHintFor(sessionId: string, text: string): Promise<string | null> {
  pending.delete(sessionId);
  if (await workflowEngine.activeRun(sessionId).catch(() => null)) return null;
  const sops = await prisma.workflow.findMany({ where: { status: 'confirmed' } });
  const hits = matchSops(
    text,
    sops.map((w) => ({ slug: w.slug, name: w.name, aliases: (w.aliases as string[] | null) ?? [] })),
  );
  if (!hits.length) return null;
  pending.set(sessionId, hits.map((h) => ({ slug: h.slug, name: h.name })));
  const list = hits.map((h) => `「${h.name}」(workflow="${h.slug}")`).join(' 或 ');
  return [
    `[工作流] 这条请求对应已确认的 SOP：${list}。`,
    '必须先调用 workflow_start 按 SOP 执行（运行标签或起点不明确先 ask_user；对应多份时先问用户用哪份），不要自己 set_plan 另写步骤，也不要沿用这个对话里以前手动做的流程。',
    '只有用户明确说不按 SOP 时才可以自己规划。',
  ].join('\n');
}

/** Bounce the first set_plan after a request that matched an SOP (null = allow). */
export async function setPlanBounce(sessionId: string): Promise<string | null> {
  const hits = pending.get(sessionId);
  if (!hits) return null;
  pending.delete(sessionId);
  if (await workflowEngine.activeRun(sessionId).catch(() => null)) return null;
  return (
    `还不能自己建任务流：用户这条请求对应已确认的 SOP ${hits.map((h) => `「${h.name}」(workflow="${h.slug}")`).join(' / ')}。` +
    '请调用 workflow_start 按 SOP 执行。如果用户明确说了不按 SOP，再调用一次 set_plan 即可（这次不会再拦）。'
  );
}
