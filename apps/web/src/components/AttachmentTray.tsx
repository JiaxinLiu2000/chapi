'use client';
import { File, FileSpreadsheet, FileText, X } from 'lucide-react';
import type { DraftAttachment } from '@/hooks/useAttachmentDraft';
import { formatBytes } from '@/lib/utils';

function FileGlyph({ mime, name }: { mime: string; name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime === 'application/pdf' || ext === 'pdf')
    return <FileText size={16} aria-hidden className="text-muted" />;
  if (['csv', 'xls', 'xlsx'].includes(ext))
    return <FileSpreadsheet size={16} aria-hidden className="text-muted" />;
  return <File size={16} aria-hidden className="text-muted" />;
}

/** Previews for the files staged on the composer: thumbnails for images, chips otherwise. */
export function AttachmentTray({
  items,
  onRemove,
  disabled,
}: {
  items: DraftAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-2 pb-1 pt-2" role="group" aria-label="待发送的附件">
      {items.map((a) =>
        a.previewUrl ? (
          <div
            key={a.id}
            className="anim-pop group relative h-16 w-16 overflow-hidden rounded-lg"
            title={`${a.file.name} · ${formatBytes(a.file.size)}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not a remote asset */}
            <img src={a.previewUrl} alt={a.file.name} width={64} height={64} className="h-full w-full object-cover" />
            {!disabled && (
              <button
                onClick={() => onRemove(a.id)}
                title="移除"
                aria-label={`移除 ${a.file.name}`}
                className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </div>
        ) : (
          <span
            key={a.id}
            className="anim-pop inline-flex h-9 max-w-full items-center gap-2 rounded-lg bg-panel2 pl-2.5 pr-1 text-xs text-text"
            title={`${a.file.name} · ${formatBytes(a.file.size)}`}
          >
            <FileGlyph mime={a.file.type} name={a.file.name} />
            <span className="min-w-0 max-w-[180px] truncate">{a.file.name}</span>
            <span className="shrink-0 text-2xs tabular-nums text-muted">{formatBytes(a.file.size)}</span>
            {!disabled && (
              <button
                onClick={() => onRemove(a.id)}
                title="移除"
                aria-label={`移除 ${a.file.name}`}
                className="act act--danger h-8 w-8 shrink-0"
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </span>
        ),
      )}
    </div>
  );
}
