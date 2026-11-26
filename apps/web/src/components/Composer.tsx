'use client';
import { useEffect, useState } from 'react';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { AttachmentTray } from '@/components/AttachmentTray';
import { useAttachmentDraft } from '@/hooks/useAttachmentDraft';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { cn, withAttachmentNote } from '@/lib/utils';

const draftKey = (sessionId: string) => `chapi-draft:${sessionId}`;

export function Composer({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const [text, setTextState] = useState('');
  // The unsent text is kept per session (survives reload / switching conversations).
  useEffect(() => {
    try {
      setTextState(localStorage.getItem(draftKey(sessionId)) ?? '');
    } catch {
      setTextState('');
    }
  }, [sessionId]);
  const setText = (v: string) => {
    setTextState(v);
    try {
      if (v) localStorage.setItem(draftKey(sessionId), v);
      else localStorage.removeItem(draftKey(sessionId));
    } catch {
      /* storage unavailable: the draft just lasts this page */
    }
  };
  const [sending, setSending] = useState(false);
  const runState = useStore((s) => s.runState);
  const addUser = useStore((s) => s.addOptimisticUser);
  const draft = useAttachmentDraft();
  const running = runState === 'running';

  const send = async () => {
    const t = text.trim();
    if (sending || (!t && draft.items.length === 0)) return;
    setSending(true);
    try {
      // Upload at send time (not on pick) so a draft the user clears never
      // leaves orphaned files on disk.
      const uploaded = await draft.uploadAll(sessionId);
      const msg = withAttachmentNote(t, uploaded);
      addUser(msg);
      getSocket().send({ type: 'user.message', sessionId, text: msg });
      setText('');
      draft.clear();
    } catch (e) {
      useStore.setState({
        toast: {
          level: 'error',
          title: '上传失败，消息未发送',
          body: e instanceof Error ? e.message : String(e),
          ts: Date.now(),
        },
      });
    } finally {
      setSending(false);
    }
  };

  if (disabled) {
    return (
      <div className="rounded-2xl border border-border bg-panel px-4 py-3 text-center text-sm text-muted">
        该任务已标记完成，对话只读
      </div>
    );
  }

  return (
    <div
      {...draft.dropProps}
      className={cn(
        'relative rounded-2xl border bg-panel p-2 transition-colors duration-150 ease-ui',
        draft.dragActive ? 'border-accent ring-2 ring-accent/30' : 'border-border focus-within:border-accent',
      )}
    >
      {draft.dragActive && (
        <div className="anim-fade pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-panel/95 text-sm text-accent">
          松手即可添加文件
        </div>
      )}

      <AttachmentTray items={draft.items} onRemove={draft.remove} disabled={sending} />

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={draft.onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        rows={2}
        aria-label="给 AI 的消息"
        placeholder="继续对话、补充要求，或随时中断…"
        className="max-h-48 w-full resize-none bg-transparent px-3 py-2 text-[14px] leading-relaxed outline-none placeholder:text-muted max-sm:text-base"
      />
      <div className="flex items-center justify-between p-1">
        <button
          onClick={draft.openPicker}
          disabled={sending}
          className="btn btn--ghost btn--icon"
          title="添加文件或图片（也可拖入、粘贴）"
          aria-label="添加文件或图片"
        >
          <Paperclip size={18} aria-hidden />
        </button>
        <input ref={draft.inputRef} type="file" multiple hidden onChange={draft.onInputChange} />
        <div className="flex items-center gap-2">
          {draft.uploading && (
            <span className="text-xs text-muted" role="status">
              上传中…
            </span>
          )}
          {running && (
            <button
              onClick={() => getSocket().send({ type: 'interrupt', sessionId })}
              className="btn btn--secondary text-warn"
            >
              <Square size={14} aria-hidden /> 中断
            </button>
          )}
          <button
            onClick={() => void send()}
            disabled={sending || (!text.trim() && draft.items.length === 0)}
            className="btn btn--primary btn--icon"
            aria-label="发送"
            title="发送（Enter）"
          >
            <ArrowUp size={18} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
