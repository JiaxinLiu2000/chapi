'use client';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { BookOpen, HelpCircle, ClipboardCheck, ChevronDown, ChevronUp } from 'lucide-react';
import type { ApprovalRequestDTO, PendingQuestionDTO } from '@chapi/shared';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { getSocket } from '@/lib/ws';
import { scheduleUndoable } from '@/lib/undoable';
import { Markdown } from './Markdown';
import { Button } from './ui/Button';

const textareaCls = 'field resize-y leading-relaxed';

/** Multi-line input: Enter = newline, Ctrl/⌘+Enter = submit. */
const submitOnModEnter = (fn: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    fn();
  }
};

function QuestionCard({ sessionId, q }: { sessionId: string; q: PendingQuestionDTO }) {
  const [answer, setAnswer] = useState('');
  const learning = q.source === 'learning';
  const submit = (text: string) => {
    if (!text.trim()) return;
    getSocket().send({ type: 'answer.question', sessionId, questionId: q.id, answer: text });
  };
  return (
    <div
      className={cn(
        'anim-rise rounded-xl border border-l-[3px] border-border bg-panel p-3 sm:p-4',
        learning ? 'border-l-accent' : 'border-l-warn',
      )}
    >
      <div className={cn('mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium', learning ? 'text-accent' : 'text-warn')}>
        {learning ? <BookOpen size={16} aria-hidden /> : <HelpCircle size={16} aria-hidden />}
        {learning ? '学习代理想确认你的偏好' : 'AI 需要你的输入'}
        {learning && <span className="text-2xs font-normal text-muted">不会打断主代理，回答后会更新知识图谱</span>}
      </div>
      <div className="mb-3 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{learning ? q.question.replace(/^【学习代理·偏好确认】/, '') : q.question}</div>
      {q.options && q.options.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {q.options.map((opt) => (
            <Button key={opt} variant="default" className="h-auto min-h-9 whitespace-normal py-1.5 text-left" onClick={() => submit(opt)}>
              {opt}
            </Button>
          ))}
        </div>
      )}
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={submitOnModEnter(() => submit(answer))}
        rows={3}
        aria-label="你的回答"
        placeholder={
          q.options && q.options.length > 0
            ? '或者输入其它回答…（Enter 换行，Ctrl+Enter 发送）'
            : '输入你的回答…（Enter 换行，Ctrl+Enter 发送）'
        }
        className={textareaCls}
      />
      <div className="mt-2 flex justify-end">
        <Button variant="accent" onClick={() => submit(answer)} disabled={!answer.trim()}>
          发送
        </Button>
      </div>
    </div>
  );
}

/** Feedback typed into an approval card, kept across a 驳回 → 撤销 (the card remounts). */
const feedbackDrafts = new Map<string, string>();

function ApprovalCard({ sessionId, a }: { sessionId: string; a: ApprovalRequestDTO }) {
  const [feedback, setFeedbackState] = useState(() => feedbackDrafts.get(a.id) ?? '');
  const setFeedback = (v: string) => {
    feedbackDrafts.set(a.id, v);
    setFeedbackState(v);
  };
  const send = (decision: 'approve' | 'reject' | 'revise', text: string) =>
    getSocket().send({ type: 'approval.decision', sessionId, approvalId: a.id, decision, feedback: text });
  const decide = (decision: 'approve' | 'revise') => {
    feedbackDrafts.delete(a.id);
    send(decision, feedback);
  };
  // 驳回: the card leaves at once; the decision (with its feedback) is sent after the
  // undo window. 撤销 puts the card back where it was, feedback included.
  const reject = () => {
    const text = feedback;
    const at = useStore.getState().approvals.findIndex((x) => x.id === a.id);
    useStore.setState((s) => ({ approvals: s.approvals.filter((x) => x.id !== a.id) }));
    scheduleUndoable({
      label: '已驳回',
      commit: () => {
        feedbackDrafts.delete(a.id);
        send('reject', text);
      },
      revert: () =>
        useStore.setState((s) => {
          // Only back into this session's list (the user may have opened another one meanwhile).
          if (s.sessionId !== sessionId || s.approvals.some((x) => x.id === a.id)) return s;
          const next = [...s.approvals];
          next.splice(at < 0 ? next.length : Math.min(at, next.length), 0, a);
          return { approvals: next };
        }),
    });
  };
  return (
    <div className="anim-rise rounded-xl border border-l-[3px] border-border border-l-success bg-panel p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-success">
        <ClipboardCheck size={16} aria-hidden /> 成果待审批
      </div>
      <div className="mb-3 text-sm">
        <Markdown content={a.summary} />
      </div>
      {a.artifacts.length > 0 && (
        <ul className="mb-3 space-y-1 text-xs">
          {a.artifacts.map((art) => (
            <li key={art.id} className="min-w-0">
              <a
                className="break-all text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
                href={art.pathOrUrl}
                target="_blank"
                rel="noreferrer"
              >
                {art.title || art.pathOrUrl}
              </a>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={submitOnModEnter(() => feedback.trim() && decide('revise'))}
        rows={4}
        aria-label="修改意见"
        placeholder="修改意见（可选，可多行；Ctrl+Enter = 要求修改）…"
        className={`mb-2 ${textareaCls}`}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="success" onClick={() => decide('approve')}>
          通过
        </Button>
        <Button variant="default" onClick={() => decide('revise')}>
          要求修改
        </Button>
        <Button variant="ghost" onClick={reject}>
          驳回
        </Button>
      </div>
    </div>
  );
}

const HEIGHT_KEY = 'chapi.questionDock.height';
const COLLAPSED_KEY = 'chapi.questionDock.collapsed';
const MIN_HEIGHT = 80;
const maxHeight = () => Math.round(window.innerHeight * 0.85);

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the size just won't persist */
  }
}

export function QuestionDock({ sessionId }: { sessionId: string }) {
  const questions = useStore((s) => s.questions);
  const approvals = useStore((s) => s.approvals);
  // null = auto height (capped at 45vh); a number = the height the user dragged to.
  const [height, setHeight] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = Number(readPref(HEIGHT_KEY));
    if (h > 0) setHeight(Math.min(Math.max(h, MIN_HEIGHT), maxHeight()));
    setCollapsed(readPref(COLLAPSED_KEY) === '1');
  }, []);

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (collapsed || !boxRef.current) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = boxRef.current.getBoundingClientRect().height;
    let last = startH;
    const onMove = (ev: PointerEvent) => {
      // Dragging the handle UP makes the dock taller (it grows toward the chat).
      last = Math.min(Math.max(startH + (startY - ev.clientY), MIN_HEIGHT), maxHeight());
      setHeight(last);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      writePref(HEIGHT_KEY, String(Math.round(last)));
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Keyboard alternative to dragging: ↑/↓ resize by 24px, Home goes back to auto height.
  const keyResize = (e: KeyboardEvent<HTMLDivElement>) => {
    if (collapsed || !boxRef.current) return;
    if (e.key === 'Home') {
      e.preventDefault();
      resetHeight();
      return;
    }
    const d = e.key === 'ArrowUp' ? 24 : e.key === 'ArrowDown' ? -24 : 0;
    if (!d) return;
    e.preventDefault();
    const next = Math.min(Math.max(boxRef.current.getBoundingClientRect().height + d, MIN_HEIGHT), maxHeight());
    setHeight(next);
    writePref(HEIGHT_KEY, String(Math.round(next)));
  };

  const resetHeight = () => {
    setHeight(null);
    writePref(HEIGHT_KEY, null);
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writePref(COLLAPSED_KEY, c ? null : '1');
      return !c;
    });
  };

  if (questions.length === 0 && approvals.length === 0) return null;

  const parts = [
    questions.length > 0 ? `${questions.length} 个问题` : '',
    approvals.length > 0 ? `${approvals.length} 项成果待审批` : '',
  ].filter(Boolean);

  return (
    <div>
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整高度，双击恢复默认（也可用上下方向键，Home 恢复）"
          aria-valuenow={height ?? undefined}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={keyResize}
          onDoubleClick={resetHeight}
          title="拖动调整高度，双击恢复默认"
          className="group -mt-1 flex h-4 cursor-row-resize touch-none items-center justify-center"
        >
          <div className="h-1 w-10 rounded-full bg-border transition-colors group-hover:bg-accent" />
        </div>
      )}
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="tabular-nums" role="status">
          待处理：{parts.join('，')}
        </span>
        <button onClick={toggleCollapsed} aria-expanded={!collapsed} className="act h-8 px-2">
          {collapsed ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      {!collapsed && (
        <div
          ref={boxRef}
          style={height !== null ? { height } : undefined}
          className={cn('scroll-area anim-drop space-y-2', height === null && 'max-h-[45dvh]')}
        >
          {questions.map((q) => (
            <QuestionCard key={q.id} sessionId={sessionId} q={q} />
          ))}
          {approvals.map((a) => (
            <ApprovalCard key={a.id} sessionId={sessionId} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}
