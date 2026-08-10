'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp, Paperclip, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { AttachmentTray } from '@/components/AttachmentTray';
import { useAttachmentDraft } from '@/hooks/useAttachmentDraft';
import { useStore } from '@/lib/store';
import { cn, withAttachmentNote } from '@/lib/utils';

const EXAMPLES = [
  '在网上调研竞品定价，整理成一份对比表格放进 Google Sheet',
  '把这份 PDF 模板里的客户名称和金额替换成新数据',
  '根据资料起草一封邮件并存到 Gmail 草稿',
];

export default function HomePage() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = useAttachmentDraft();

  const start = async (msg: string) => {
    const trimmed = msg.trim();
    if (busy || (!trimmed && draft.items.length === 0)) return;
    setBusy(true);
    // With files but no prose, the first filename is the most useful title seed.
    const seed = trimmed || draft.items[0]?.file.name || '新任务';
    try {
      // ask for desktop notifications up front
      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => undefined);
      }
      const { session } = await api.createSession(seed);

      let uploaded;
      try {
        uploaded = await draft.uploadAll(session.id);
      } catch (e) {
        // The session has no messages yet, so drop it rather than strand an
        // empty one; the draft stays put so the user can just hit send again.
        await api.deleteSession(session.id).catch(() => undefined);
        throw e;
      }

      const full = withAttachmentNote(trimmed, uploaded);
      sessionStorage.setItem(`chapi:pending:${session.id}`, full);
      draft.clear();
      router.push(`/s/${session.slug}`);
    } catch (e) {
      setBusy(false);
      useStore.setState({
        toast: {
          level: 'error',
          title: '创建会话失败',
          body: e instanceof Error ? e.message : String(e),
          ts: Date.now(),
        },
      });
    }
  };

  const canSend = !busy && (text.trim().length > 0 || draft.items.length > 0);

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

      <div
        {...draft.dropProps}
        className={cn(
          'relative w-full rounded-2xl border bg-panel p-2 shadow-xl transition',
          draft.dragActive ? 'border-accent ring-2 ring-accent/30' : 'border-border',
        )}
      >
        {draft.dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-panel/90 text-sm text-accent">
            松手即可添加文件
          </div>
        )}

        <AttachmentTray items={draft.items} onRemove={draft.remove} disabled={busy} />

        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={draft.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start(text);
            }
          }}
          rows={3}
          placeholder="例如：在网上查找最新的行业报告并总结成文档…（可拖入或粘贴文件、截图）"
          className="max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-muted/60"
        />
        <div className="flex items-center justify-between p-1">
          <button
            onClick={draft.openPicker}
            disabled={busy}
            className="rounded-lg p-2 text-muted transition hover:bg-panel2 hover:text-text disabled:opacity-50"
            title="添加文件/图片"
          >
            <Paperclip size={18} />
          </button>
          <input
            ref={draft.inputRef}
            type="file"
            multiple
            hidden
            onChange={draft.onInputChange}
          />
          <div className="flex items-center gap-2">
            {busy && draft.uploading && <span className="text-xs text-muted">上传中…</span>}
            <button
              onClick={() => void start(text)}
              disabled={!canSend}
              className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-white transition hover:brightness-110 disabled:opacity-40"
            >
              <ArrowUp size={18} />
            </button>
          </div>
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
