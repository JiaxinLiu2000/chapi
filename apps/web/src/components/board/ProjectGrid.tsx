'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderSync, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Modal } from '@/components/ui/Modal';
import { ProjectCard } from './ProjectCard';

/** Projects as a card grid (auto-fill, ≥280px each); 「未归类」 always last. */
export function ProjectGrid() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  // `classifying` is the server's flag; board.changed refetches it, plus a light poll while it's on.
  const { data, isLoading, error } = useQuery({
    queryKey: ['board', 'projects'],
    queryFn: api.boardProjects,
    refetchInterval: (q) => (q.state.data?.classifying ? 3000 : false),
  });
  const classifying = starting || !!data?.classifying;

  const start = async () => {
    setConfirming(false);
    setStarting(true);
    try {
      await api.classifySessions();
      await qc.invalidateQueries({ queryKey: ['board', 'projects'] });
      useStore.setState({ toast: { level: 'info', title: '已开始重新归类', body: '副 AI 正在逐批归类会话，完成后这里会自动刷新。', ts: Date.now() } });
    } catch (e) {
      useStore.setState({ toast: { level: 'error', title: '没能开始归类', body: e instanceof Error ? e.message : String(e), ts: Date.now() } });
    } finally {
      setStarting(false);
    }
  };

  const projects = data?.projects ?? [];
  const total = projects.reduce((n, p) => n + p.sessionCount, 0) + (data?.unassignedCount ?? 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-sm text-muted">
          {data ? (
            <>
              <span className="tabular-nums">{projects.length}</span> 个项目，
              <span className="tabular-nums">{data.unassignedCount}</span> 个会话未归类
            </>
          ) : (
            ' '
          )}
        </p>
        <button type="button" className="btn btn--secondary btn--sm" disabled={classifying || !data} onClick={() => setConfirming(true)}>
          {classifying ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FolderSync size={14} aria-hidden />}
          {classifying ? '归类中…' : '重新归类'}
        </button>
      </div>

      {isLoading && <div className="text-sm text-muted" role="status">加载中…</div>}
      {error && <div className="text-sm text-danger">读取失败：{error instanceof Error ? error.message : String(error)}</div>}
      {data && projects.length === 0 && (
        <p className="mb-4 rounded-lg bg-panel2/60 px-3 py-4 text-sm text-muted">还没有项目。点「重新归类」，让 AI 把会话分到项目里。</p>
      )}
      {data && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] items-start gap-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} projects={projects} />
          ))}
          {data.unassignedCount > 0 && <ProjectCard project={null} unassignedCount={data.unassignedCount} projects={projects} />}
        </ul>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="重新归类全部会话？"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button type="button" className="btn btn--primary" onClick={start}>
              开始归类
            </button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p>
            副 AI 会读一遍全部 <span className="tabular-nums">{total}</span> 个会话的标题和摘要，重新分到项目里，需要一两分钟，期间可以离开这个页面。
          </p>
          <p>你手动改过归属的会话不会被动。</p>
        </div>
      </Modal>
    </>
  );
}
