'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowUp, Paperclip } from 'lucide-react';
import { api } from '@/lib/api';
import { AttachmentTray } from '@/components/AttachmentTray';
import { ConfigSelectors, type RunConfig } from '@/components/ConfigSelectors';
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Focus the prompt on desktop only — on phones it would pop the keyboard over the page.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  const { data: settingsData } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const st = settingsData?.settings;
  const [cfg, setCfg] = useState<RunConfig>({
    model: '',
    subagentModel: '',
    effort: 'high',
    language: 'zh',
    accountMode: 'auto',
    qualityReviewMinutes: 5,
    qualityModel: '',
  });
  // Seed the model dropdowns from the configured defaults once settings load.
  useEffect(() => {
    if (st) setCfg((c) => (c.model ? c : { ...c, model: st.mainModel, subagentModel: st.subagentModel }));
  }, [st]);

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
      const { session } = await api.createSession(seed, {
        model: cfg.model || undefined,
        subagentModel: cfg.subagentModel || undefined,
        effort: cfg.effort,
        language: cfg.language,
        accountMode: cfg.accountMode,
        qualityReviewMinutes: cfg.qualityReviewMinutes,
        qualityModel: cfg.qualityModel || undefined,
      });

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
    <main id="main" tabIndex={-1} className="mx-auto flex outline-none min-h-[calc(100dvh-3.5rem)] max-w-2xl flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 text-center">
        <h1 className="text-[22px] font-medium leading-tight sm:text-[26px]">你想完成什么任务？</h1>
        <p className="mx-auto mt-3 max-w-md text-balance text-sm leading-relaxed text-muted [word-break:keep-all]">
          描述任务，Claude Code 会规划、调用工具、派发子代理，最后把成果交给你审批
        </p>
      </div>

      <div
        {...draft.dropProps}
        className={cn(
          'relative w-full rounded-2xl border bg-panel p-2 transition-colors duration-150 ease-ui',
          draft.dragActive ? 'border-accent ring-2 ring-accent/30' : 'border-border focus-within:border-accent',
        )}
      >
        {draft.dragActive && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-panel/90 text-sm text-accent">
            松手即可添加文件
          </div>
        )}

        <AttachmentTray items={draft.items} onRemove={draft.remove} disabled={busy} />

        <textarea
          ref={inputRef}
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
          aria-label="描述你的任务"
          placeholder="例如：在网上查找最新的行业报告并总结成文档…"
          className="max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[14px] leading-relaxed outline-none placeholder:text-muted max-sm:text-base"
        />
        <div className="flex items-center justify-between p-1">
          <button
            onClick={draft.openPicker}
            disabled={busy}
            className="btn btn--ghost btn--icon"
            title="添加文件或图片（也可拖入、粘贴）"
            aria-label="添加文件或图片"
          >
            <Paperclip size={18} aria-hidden />
          </button>
          <input
            ref={draft.inputRef}
            type="file"
            multiple
            hidden
            onChange={draft.onInputChange}
          />
          <div className="flex items-center gap-2">
            {busy && draft.uploading && (
              <span className="text-xs text-muted" role="status">
                上传中…
              </span>
            )}
            <button
              onClick={() => void start(text)}
              disabled={!canSend}
              className="btn btn--primary btn--icon"
              aria-label="开始任务"
              title="开始任务（Enter）"
            >
              <ArrowUp size={18} aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* phones: labelled grid; sm+: one centred row */}
      <div className="mt-4 grid w-full grid-cols-2 gap-3 sm:hidden">
        <ConfigSelectors
          value={cfg}
          settings={st}
          disabled={busy}
          onChange={(partial) => setCfg((c) => ({ ...c, ...partial }))}
          stack
        />
      </div>
      <div className="mt-4 hidden w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:flex">
        <ConfigSelectors
          value={cfg}
          settings={st}
          disabled={busy}
          onChange={(partial) => setCfg((c) => ({ ...c, ...partial }))}
        />
      </div>

      <div className="mt-8 w-full">
        <div className="label mb-2 px-1">试试这些</div>
        <div className="flex flex-col gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => void start(ex)}
              disabled={busy}
              className="group flex items-center gap-3 rounded-xl border border-border bg-panel px-4 py-3 text-left text-sm text-muted transition-[color,background-color,border-color,transform] duration-150 ease-ui hover:border-text/25 hover:text-text active:scale-[0.99] disabled:opacity-50"
            >
              <span className="min-w-0 flex-1 text-pretty">{ex}</span>
              <ArrowRight
                size={16}
                aria-hidden
                className="text-muted opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              />
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
