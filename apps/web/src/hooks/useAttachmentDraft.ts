'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  formatBytes,
  type UploadedAttachment,
} from '@/lib/utils';

/** A file picked but not yet uploaded — uploads happen when the message is sent. */
export interface DraftAttachment {
  id: string;
  file: File;
  /** Object URL for image previews; null for every other type. Revoked on removal. */
  previewUrl: string | null;
}

let seq = 0;

const isImage = (f: File): boolean => f.type.startsWith('image/');

/** Screenshots arrive from the clipboard as a generic "image.png" — timestamp them. */
function nameClipboardFile(file: File): File {
  if (!/^image\.\w+$/i.test(file.name)) return file;
  const ext = file.name.split('.').pop() ?? 'png';
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  return new File([file], `粘贴图片-${stamp}.${ext}`, { type: file.type });
}

/**
 * Attachment draft shared by the home page and the in-session composer: holds
 * the picked files locally, renders previews, accepts drops/pastes, and uploads
 * everything in one request when the caller is ready to send.
 *
 * The home page has no session until send time, which is why nothing is
 * uploaded on pick — both call sites upload against a known session id.
 */
export function useAttachmentDraft() {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave also fire when crossing child elements, so track depth.
  const dragDepth = useRef(0);

  // Revoke every outstanding preview URL on unmount without re-running (and
  // tearing down live previews) each time the list changes.
  const urlsRef = useRef<string[]>([]);
  useEffect(() => {
    urlsRef.current = items.flatMap((i) => (i.previewUrl ? [i.previewUrl] : []));
  }, [items]);
  useEffect(() => () => urlsRef.current.forEach(URL.revokeObjectURL), []);

  const add = useCallback(
    (incoming: FileList | File[] | null | undefined) => {
      const files = Array.from(incoming ?? []).map(nameClipboardFile);
      if (files.length === 0) return;

      const accepted: DraftAttachment[] = [];
      const rejected: string[] = [];
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          rejected.push(`${file.name}（超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}）`);
          continue;
        }
        if (items.length + accepted.length >= MAX_ATTACHMENTS) {
          rejected.push(`${file.name}（一次最多 ${MAX_ATTACHMENTS} 个）`);
          continue;
        }
        const dup = (d: DraftAttachment) =>
          d.file.name === file.name && d.file.size === file.size;
        if (items.some(dup) || accepted.some(dup)) continue;
        accepted.push({
          id: `att-${++seq}`,
          file,
          previewUrl: isImage(file) ? URL.createObjectURL(file) : null,
        });
      }

      if (accepted.length > 0) setItems((prev) => [...prev, ...accepted]);
      if (rejected.length > 0) {
        useStore.setState({
          toast: {
            level: 'error',
            title: '部分文件未添加',
            body: rejected.join('；'),
            ts: Date.now(),
          },
        });
      }
    },
    [items],
  );

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const hit = prev.find((i) => i.id === id);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setItems((prev) => {
      for (const i of prev) if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
      return [];
    });
  }, []);

  /** Upload the whole draft against a session. Throws on failure; caller decides. */
  const uploadAll = useCallback(
    async (sessionId: string): Promise<UploadedAttachment[]> => {
      if (items.length === 0) return [];
      setUploading(true);
      try {
        const r = await api.upload(
          sessionId,
          items.map((i) => i.file),
        );
        return r.attachments.map((a) => ({
          filename: a.filename,
          sandboxPath: a.sandboxPath ?? a.filename,
        }));
      } finally {
        setUploading(false);
      }
    },
    [items],
  );

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      add(e.target.files);
      e.target.value = ''; // allow re-picking the same file
    },
    [add],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return; // plain text paste — leave it alone
      e.preventDefault();
      add(files);
    },
    [add],
  );

  const hasFiles = (e: DragEvent<HTMLElement>) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const dropProps = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragActive(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required, or the drop never fires
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      add(e.dataTransfer.files);
    },
  };

  return {
    items,
    uploading,
    dragActive,
    add,
    remove,
    clear,
    uploadAll,
    openPicker,
    inputRef,
    onInputChange,
    onPaste,
    dropProps,
  };
}
