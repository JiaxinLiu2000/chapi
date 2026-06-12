'use client';
import { useState } from 'react';
import { HelpCircle, ClipboardCheck } from 'lucide-react';
import type { ApprovalRequestDTO, PendingQuestionDTO } from '@chapi/shared';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { Button } from './ui/Button';

function QuestionCard({ sessionId, q }: { sessionId: string; q: PendingQuestionDTO }) {
  const [answer, setAnswer] = useState('');
  const submit = (text: string) => {
    if (!text.trim()) return;
    getSocket().send({ type: 'answer.question', sessionId, questionId: q.id, answer: text });
  };
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/10 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-warn">
        <HelpCircle size={16} /> AI 需要你的输入
      </div>
      <div className="mb-2 whitespace-pre-wrap text-sm">{q.question}</div>
      {q.options && q.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {q.options.map((opt) => (
            <Button key={opt} variant="default" onClick={() => submit(opt)}>
              {opt}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit(answer)}
            placeholder="输入你的回答…"
            className="flex-1 rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <Button variant="accent" onClick={() => submit(answer)}>
            发送
          </Button>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ sessionId, a }: { sessionId: string; a: ApprovalRequestDTO }) {
  const [feedback, setFeedback] = useState('');
  const decide = (decision: 'approve' | 'reject' | 'revise') =>
    getSocket().send({ type: 'approval.decision', sessionId, approvalId: a.id, decision, feedback });
  return (
    <div className="rounded-xl border border-success/40 bg-success/10 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-success">
        <ClipboardCheck size={16} /> 成果待审批
      </div>
      <div className="mb-2 whitespace-pre-wrap text-sm">{a.summary}</div>
      {a.artifacts.length > 0 && (
        <ul className="mb-2 space-y-1 text-xs">
          {a.artifacts.map((art) => (
            <li key={art.id}>
              <a className="text-accent underline" href={art.pathOrUrl} target="_blank" rel="noreferrer">
                {art.title || art.pathOrUrl}
              </a>
            </li>
          ))}
        </ul>
      )}
      <input
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="修改意见（可选）…"
        className="mb-2 w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <div className="flex gap-2">
        <Button variant="success" onClick={() => decide('approve')}>
          通过
        </Button>
        <Button variant="default" onClick={() => decide('revise')}>
          要求修改
        </Button>
        <Button variant="ghost" onClick={() => decide('reject')}>
          驳回
        </Button>
      </div>
    </div>
  );
}

export function QuestionDock({ sessionId }: { sessionId: string }) {
  const questions = useStore((s) => s.questions);
  const approvals = useStore((s) => s.approvals);
  if (questions.length === 0 && approvals.length === 0) return null;
  return (
    <div className="space-y-2">
      {questions.map((q) => (
        <QuestionCard key={q.id} sessionId={sessionId} q={q} />
      ))}
      {approvals.map((a) => (
        <ApprovalCard key={a.id} sessionId={sessionId} a={a} />
      ))}
    </div>
  );
}
