'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';

const EXAMPLES = [
  '在网上调研竞品定价，整理成一份对比表格放进 Google Sheet',
  '把这份 PDF 模板里的客户名称和金额替换成新数据',
  '根据资料起草一封邮件并存到 Gmail 草稿',
];

export default function HomePage() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async (msg: string) => {
    const trimmed = msg.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      // ask for desktop notifications up front
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => undefined);
      }
      const { session } = await api.createSession(trimmed);
      sessionStorage.setItem(`chapi:pending:${session.id}`, trimmed);
      router.push(`/s/${session.slug}`);
    } catch (e) {
      setBusy(false);
      alert(e instanceof Error ? e.message : '创建会话失败');
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-2xl flex-col items-center justify-center px-4">
      <div className="mb-8 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1 text-xs text-muted">
          <Sparkles size={14} className="text-accent" /> 用自然语言驱动 Claude Code
        </div>
        <h1 className="text-2xl font-semibold">你想完成什么任务？</h1>
        <p className="mt-2 text-sm text-muted">
          描述任务，AI 会规划、调用工具、派发子代理，并把结果交给你审批。
        </p>
      </div>

      <div className="w-full rounded-2xl border border-border bg-panel p-2 shadow-xl">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start(text);
            }
          }}
          rows={3}
          placeholder="例如：在网上查找最新的行业报告并总结成文档…"
          className="max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-muted/60"
        />
        <div className="flex justify-end p-1">
          <button
            onClick={() => void start(text)}
            disabled={busy || !text.trim()}
            className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-white transition hover:brightness-110 disabled:opacity-40"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>

      <div className="mt-6 flex w-full flex-col gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => void start(ex)}
            disabled={busy}
            className="rounded-lg border border-border bg-panel px-3 py-2 text-left text-sm text-muted transition hover:border-accent hover:text-text"
          >
            {ex}
          </button>
        ))}
      </div>
    </main>
  );
}
