/**
 * One-off: write already-decided approvals and answered ask_user questions into
 * their conversations (see engine/hitlTranscript.ts). Idempotent — skips any
 * whose transcript bubble already exists.  Run: npx tsx scripts/backfill-hitl-transcript.ts
 */
import { prisma } from '../src/db/client.js';
import { recordAnswer, recordApproval } from '../src/engine/hitlTranscript.js';

async function exists(sessionId: string, type: string, at: Date): Promise<boolean> {
  return (await prisma.message.count({ where: { sessionId, type, createdAt: at } })) > 0;
}

const approvals = await prisma.approval.findMany({ where: { status: { not: 'open' } } });
let a = 0;
for (const row of approvals) {
  if (await exists(row.sessionId, 'approval', row.createdAt)) continue;
  const decision = row.status === 'approved' ? 'approve' : row.status === 'rejected' ? 'reject' : row.status;
  await recordApproval(row, decision, row.feedback, false);
  a += 1;
}
const questions = await prisma.pendingQuestion.findMany({ where: { status: 'answered' } });
let q = 0;
for (const row of questions) {
  if (await exists(row.sessionId, 'question', row.createdAt)) continue;
  await recordAnswer(row, row.answer ?? '', false);
  q += 1;
}
console.log(`backfilled ${a}/${approvals.length} approvals, ${q}/${questions.length} questions`);
await prisma.$disconnect();
