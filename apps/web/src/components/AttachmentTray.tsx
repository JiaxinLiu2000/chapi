'use client';
import { File, FileSpreadsheet, FileText, X } from 'lucide-react';
import type { DraftAttachment } from '@/hooks/useAttachmentDraft';
import { formatBytes } from '@/lib/utils';

function FileGlyph({ mime, name }: { mime: string; name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime === 'application/pdf' || ext === 'pdf')
    return <FileText size={14} className="text-danger/80" />;
  if (['csv', 'xls', 'xlsx'].includes(ext))
    return <FileSpreadsheet size={14} className="text-success/80" />;
  return <File size={14} className="text-muted" />;
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
    <div className="flex flex-wrap items-center gap-2 px-2 pb-1 pt-2">
      {items.map((a) =>
        a.previewUrl ? (
          <div
            key={a.id}
            className="group relative h-14 w-14 overflow-hidden rounded-lg border border-border"
            title={`${a.file.name} · ${formatBytes(a.file.size)}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not a remote asset */}
            <img src={a.previewUrl} alt={a.file.name} className="h-full w-full object-cover" />
            {!disabled && (
              <button
                onClick={() => onRemove(a.id)}
                title="移除"
                className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100"
              >
                <X size={10} />
              </button>
            )}
          </div>
        ) : (
          <span
            key={a.id}
            className="inline-flex items-center gap-1.5 rounded-md bg-panel2 px-2 py-1.5 text-xs text-text"
            title={`${a.file.name} · ${formatBytes(a.file.size)}`}
          >
            <FileGlyph mime={a.file.type} name={a.file.name} />
            <span className="max-w-[160px] truncate">{a.file.name}</span>
            <span className="text-[10px] text-muted">{formatBytes(a.file.size)}</span>
            {!disabled && (
              <button
                onClick={() => onRemove(a.id)}
                title="移除"
                className="text-muted transition hover:text-danger"
              >
                <X size={12} />
              </button>
            )}
          </span>
        ),
      )}
    </div>
  );
}
