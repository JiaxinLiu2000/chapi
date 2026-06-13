'use client';
import { useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';

export function Composer({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const runState = useStore((s) => s.runState);
  const addUser = useStore((s) => s.addOptimisticUser);
  const pending = useStore((s) => s.pendingAttachments);
  const addPending = useStore((s) => s.addPendingAttachments);
  const clearPending = useStore((s) => s.clearPendingAttachments);
  const fileRef = useRef<HTMLInputElement>(null);
  const running = runState === 'running';

  const send = () => {
    const t = text.trim();
    if (!t && pending.length === 0) return;
    // Append the just-uploaded file locations so the agent can find them at once.
    let msg = t;
    if (pending.length > 0) {
      const lines = pending.map((a) => `- ${a.filename} → ${a.sandboxPath}`).join('\n');
      msg = `${t ? `${t}\n\n` : ''}[本次上传的文件（位于会话沙盘，可直接读取/编辑）]\n${lines}`;
    }
    addUser(msg);
    getSocket().send({ type: 'user.message', sessionId, text: msg });
    setText('');
    clearPending();
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const r = await api.upload(sessionId, Array.from(files));
      addPending(
        r.attachments.map((a) => ({ filename: a.filename, sandboxPath: a.sandboxPath ?? a.filename })),
      );
      useStore.setState({
        toast: {
          level: 'info',
          title: '已上传，将随下条消息发给 AI',
          body: r.attachments.map((a) => a.filename).join(', '),
          ts: Date.now(),
        },
      });
    } catch (e) {
      useStore.setState({
        toast: { level: 'error', title: '上传失败', body: String(e), ts: Date.now() },
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (disabled) {
    return (
      <div className="rounded-xl border border-border bg-panel px-4 py-3 text-center text-sm text-muted">
        该任务已标记完成，对话只读。
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-panel p-2">
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-1 pt-1">
          {pending.map((a, i) => (
            <span
              key={`${a.sandboxPath}-${i}`}
              className="inline-flex items-center gap-1 rounded-md bg-panel2 px-2 py-1 text-xs text-text"
              title={a.sandboxPath}
            >
              <Paperclip size={12} className="text-muted" />
              <span className="max-w-[160px] truncate">{a.filename}</span>
              <button
                onClick={() =>
                  useStore.setState((s) => ({
                    pendingAttachments: s.pendingAttachments.filter((_, j) => j !== i),
                  }))
                }
                className="text-muted hover:text-danger"
                title="移除"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        placeholder="继续对话、补充要求，或随时中断…"
        className="max-h-48 w-full resize-none bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-muted/50"
      />
      <div className="flex items-center justify-between p-1">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="rounded-lg p-2 text-muted transition hover:bg-panel2 hover:text-text disabled:opacity-50"
          title="上传文件/图片"
        >
          <Paperclip size={18} />
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        <div className="flex items-center gap-2">
          {running && (
            <button
              onClick={() => getSocket().send({ type: 'interrupt', sessionId })}
              className="inline-flex items-center gap-1 rounded-lg bg-panel2 px-3 py-2 text-sm text-warn transition hover:bg-border"
            >
              <Square size={14} /> 中断
            </button>
          )}
          <button
            onClick={send}
            disabled={!text.trim() && pending.length === 0}
            className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-white transition hover:brightness-110 disabled:opacity-40"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
