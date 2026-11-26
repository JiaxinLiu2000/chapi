'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  KNOWLEDGE_KIND_LABEL,
  KNOWLEDGE_SECTION_LABEL,
  type KnowledgeKind,
  type WikiEntryDTO,
  type WikiUpsertInput,
} from '@chapi/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/Button';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Modal } from './ui/Modal';
import { useDiscardGuard } from './ui/useDiscardGuard';

const inputCls = 'field';

const splitList = (s: string) =>
  s
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** "url | 2026-10-01 | official" per line ⇄ sourceRefs */
function sourcesToText(e: WikiEntryDTO | null): string {
  return (e?.sourceRefs ?? []).map((s) => [s.ref, s.date ?? '', s.tier ?? ''].join(' | ').replace(/( \| )+$/, '')).join('\n');
}
function textToSources(t: string): NonNullable<WikiUpsertInput['sourceRefs']> {
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [ref, date, tier] = l.split('|').map((x) => x.trim());
      return {
        kind: /^https?:/i.test(ref!) ? 'web' : ref === 'user' ? 'user' : 'raw-material',
        ref: ref!,
        ...(date ? { date } : {}),
        ...(tier ? { tier } : {}),
      };
    });
}

/** Create or edit a knowledge point by hand (and delete it). */
export function KnowledgeEditor({
  open,
  entry,
  onClose,
  onSaved,
  onDeleted,
  knownTopics,
}: {
  /** Existing content categories (suggestions). */
  knownTopics?: string[];
  open: boolean;
  /** null = create a new point */
  entry: WikiEntryDTO | null;
  onClose: () => void;
  onSaved?: (e: WikiEntryDTO) => void;
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<KnowledgeKind>('skill');
  const [title, setTitle] = useState('');
  const [score, setScore] = useState(50);
  const [autoScore, setAutoScore] = useState(true);
  const [polarity, setPolarity] = useState<'positive' | 'negative'>('positive');
  const [situation, setSituation] = useState('');
  const [solution, setSolution] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [topics, setTopics] = useState('');
  const [aliases, setAliases] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [sources, setSources] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const topicsRef = useRef<HTMLInputElement>(null);
  // The fields as they were when the editor opened: any difference = unsaved edits.
  const snapshot = JSON.stringify([kind, title, score, autoScore, polarity, situation, solution, body, tags, topics, aliases, observedAt, sources]);
  const [initial, setInitial] = useState('');
  const dirty = open && initial !== '' && snapshot !== initial;
  const { requestClose, confirm: discardConfirm } = useDiscardGuard(dirty, onClose);

  useEffect(() => {
    if (!open) return;
    const f = {
      kind: entry?.kind ?? ('skill' as KnowledgeKind),
      title: entry?.title ?? '',
      score: entry?.score ?? 50,
      autoScore: !entry,
      polarity: (entry?.polarity === 'negative' ? 'negative' : 'positive') as 'positive' | 'negative',
      situation: entry?.situation ?? '',
      solution: entry?.solution ?? '',
      body: entry?.bodyMd ?? '',
      tags: (entry?.tags ?? []).join(', '),
      topics: (entry?.topics ?? []).filter((t) => t !== '未分类').join(', '),
      aliases: (entry?.aliases ?? []).join('\n'),
      observedAt: entry?.observedAt?.slice(0, 10) ?? '',
      sources: sourcesToText(entry),
    };
    setKind(f.kind);
    setTitle(f.title);
    setScore(f.score);
    setAutoScore(f.autoScore);
    setPolarity(f.polarity);
    setSituation(f.situation);
    setSolution(f.solution);
    setBody(f.body);
    setTags(f.tags);
    setTopics(f.topics);
    setAliases(f.aliases);
    setObservedAt(f.observedAt);
    setSources(f.sources);
    setInitial(JSON.stringify([f.kind, f.title, f.score, f.autoScore, f.polarity, f.situation, f.solution, f.body, f.tags, f.topics, f.aliases, f.observedAt, f.sources]));
    setErr('');
    setConfirmDel(false);
  }, [open, entry]);

  const [l1, l2] = KNOWLEDGE_SECTION_LABEL[kind];
  const scoreName = kind === 'data' ? '置信度' : '权重';

  const save = async () => {
    // The message shows under the form; the cursor goes to the field it's about.
    if (!title.trim()) {
      setErr('请填写标题');
      return titleRef.current?.focus();
    }
    const topicList = splitList(topics).slice(0, 3);
    if (!topicList.length) {
      setErr('请填写 1~3 个内容分类（哪个网站/项目/客户/工具/领域）');
      return topicsRef.current?.focus();
    }
    setBusy(true);
    setErr('');
    const payload: WikiUpsertInput = {
      title: title.trim(),
      kind,
      topics: topicList,
      situation,
      solution,
      body,
      tags: splitList(tags),
      aliases: splitList(aliases),
      polarity: kind === 'preference' ? polarity : '',
      ...(kind === 'data' ? { observedAt: observedAt || null, sourceRefs: textToSources(sources) } : {}),
      // data: leave the score to the source formula unless the user set it
      ...(kind === 'data' && autoScore ? {} : { score }),
    };
    try {
      const r = entry ? await api.updateWikiEntry(entry.id, payload) : await api.createWikiEntry(payload);
      await Promise.all([qc.invalidateQueries({ queryKey: ['wiki'] }), qc.invalidateQueries({ queryKey: ['wiki-graph'] })]);
      onSaved?.(r.entry);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      await api.deleteWikiEntry(entry.id);
      await Promise.all([qc.invalidateQueries({ queryKey: ['wiki'] }), qc.invalidateQueries({ queryKey: ['wiki-graph'] })]);
      onDeleted?.();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Modal open={open} onClose={requestClose} title={entry ? '编辑知识点' : '新增知识点'} className="sm:max-w-2xl">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex gap-0.5 rounded-[10px] bg-panel2 p-0.5" role="group" aria-label="知识点类型">
            {(['skill', 'preference', 'data'] as KnowledgeKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={cn(
                  'press h-8 rounded-md px-3 text-sm [@media(pointer:coarse)]:h-10',
                  kind === k ? 'bg-panel font-medium text-text shadow-[0_0_0_1px_rgb(var(--c-border))]' : 'text-muted hover:text-text',
                )}
              >
                {KNOWLEDGE_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <span className="text-2xs text-muted">
            {kind === 'skill' ? '工具/方法的用法' : kind === 'preference' ? '用户在某类场景下的期望' : '来自文档/网络/用户的第三方数据'}
          </span>
        </div>

        <input ref={titleRef} name="title" autoComplete="off" className={inputCls} aria-label="标题" placeholder="标题（简洁具体）…" value={title} onChange={(e) => setTitle(e.target.value)} />

        <label className="block">
          <span className="text-xs text-muted">内容分类 1~3 个（逗号分隔，最重要的放第一个；如 apartments.com, Tower II 租金竞品）</span>
          <input ref={topicsRef} name="topics" autoComplete="off" list="knowledge-topics" className={cn(inputCls, 'mt-1')} value={topics} onChange={(e) => setTopics(e.target.value)} />
          <datalist id="knowledge-topics">
            {(knownTopics ?? []).map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>

        <div className="grid grid-cols-[1fr_auto] items-center gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-muted">
              {scoreName}：<span className="font-medium tabular-nums text-text">{kind === 'data' && autoScore ? '按来源自动计算' : score}</span>
              {kind === 'data' && (
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={autoScore} onChange={(e) => setAutoScore(e.target.checked)} /> 自动
                </label>
              )}
            </div>
            <input
              type="range"
              aria-label={scoreName}
              min={0}
              max={100}
              value={score}
              disabled={kind === 'data' && autoScore}
              onChange={(e) => setScore(Number(e.target.value))}
              className="h-8 w-full cursor-pointer accent-accent"
            />
          </div>
          {kind === 'preference' && (
            <div className="flex gap-1">
              {(['positive', 'negative'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={polarity === p}
                  onClick={() => setPolarity(p)}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors',
                    polarity === p ? (p === 'positive' ? 'border-success/60 bg-success/10 text-success' : 'border-danger/60 bg-danger/10 text-danger') : 'border-border text-muted hover:text-text',
                  )}
                >
                  {p === 'positive' ? <ThumbsUp size={14} aria-hidden /> : <ThumbsDown size={14} aria-hidden />}
                  {p === 'positive' ? '希望这样' : '不要这样'}
                </button>
              ))}
            </div>
          )}
          {kind === 'data' && (
            <input type="date" className={inputCls} value={observedAt} onChange={(e) => setObservedAt(e.target.value)} title="数据时间" aria-label="数据时间" />
          )}
        </div>

        <label className="block">
          <span className="text-xs text-muted">{l1}</span>
          <textarea className={cn(inputCls, 'mt-1')} rows={2} value={situation} onChange={(e) => setSituation(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">{l2}</span>
          <textarea className={cn(inputCls, 'mt-1')} rows={4} value={solution} onChange={(e) => setSolution(e.target.value)} />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-muted">
              {kind === 'skill' ? '工具标签' : kind === 'preference' ? '场景标签' : '主题标签'}（逗号分隔，同义标签会自动合并）
            </span>
            <input name="tags" autoComplete="off" className={cn(inputCls, 'mt-1')} value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs text-muted">别名 / 不同问法（每行一个）</span>
            <textarea className={cn(inputCls, 'mt-1')} rows={2} value={aliases} onChange={(e) => setAliases(e.target.value)} />
          </label>
        </div>

        {kind === 'data' && (
          <label className="block">
            <span className="text-xs text-muted">来源（每行：URL 或文件路径 | 日期 | 类型 official/reputable/aggregator/community；用户提供写 user）</span>
            <textarea className={cn(inputCls, 'mt-1 font-mono text-xs')} rows={3} value={sources} onChange={(e) => setSources(e.target.value)} />
          </label>
        )}

        <label className="block">
          <span className="text-xs text-muted">备注（Markdown，可用 [[知识点标题]] 链接）</span>
          <textarea className={cn(inputCls, 'mt-1')} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>

        {err && (
          <div className="text-xs text-danger" role="alert">
            {err}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          {entry &&
            (confirmDel ? (
              <>
                <span className="text-xs text-danger">确定删除？Obsidian 里的笔记也会删除</span>
                <Button variant="danger" disabled={busy} onClick={del}>
                  删除
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDel(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="text-danger" onClick={() => setConfirmDel(true)}>
                删除
              </Button>
            ))}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={requestClose}>
              取消
            </Button>
            <Button variant="accent" disabled={busy} onClick={save}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
    {discardConfirm}
    </>
  );
}
