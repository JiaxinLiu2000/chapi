import { prisma } from '../db/client.js';

/** One line per confirmed SOP, for the main AI's system prompt (spec §5.1). Null when there are none. */
export async function sopCatalog(): Promise<string | null> {
  const ws = await prisma.workflow.findMany({ where: { status: 'confirmed' }, orderBy: { name: 'asc' } });
  if (!ws.length) return null;
  return ws
    .map((w) => {
      const aliases = ((w.aliases as string[] | null) ?? []).filter(Boolean);
      return `- 「${w.name}」(workflow="${w.slug}")${aliases.length ? ` 别名：${aliases.join(' / ')}` : ''}${w.whenToUse ? ` —— 何时用：${w.whenToUse}` : ''}`;
    })
    .join('\n');
}
