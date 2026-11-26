'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { QuestionDock } from './QuestionDock';
import { RunConfigBar } from './RunConfigBar';

// Scrolling within this many px of the top triggers loading the previous page
// of older messages (infinite-scroll-up), so long sessions don't load/render
// their entire history up front.
const LOAD_EARLIER_THRESHOLD_PX = 150;

// Jumping to a search hit pages back through history until the message turns
// up; stop after this many pages (200 messages each) rather than loop forever.
const MAX_JUMP_PAGES = 50;

/** First case-insensitive occurrence of `needle` in `root`'s rendered text, as a Range. */
function findTextRange(root: HTMLElement, needle: string): Range | null {
  const n = needle.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node.textContent ?? '').toLowerCase().indexOf(n);
    if (at >= 0) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      return range;
    }
  }
  return null;
}

export function Chat({
  sessionId,
  focusMessageId,
  focusQuery,
}: {
  sessionId: string;
  /** From a history-search hit: scroll to and briefly highlight this message. */
  focusMessageId?: string | null;
  /** The search term behind that hit — scrolled to and highlighted within the message. */
  focusQuery?: string | null;
}) {
  const messages = useStore((s) => s.messages);
  const hasMoreMessages = useStore((s) => s.hasMoreMessages);
  const prependMessages = useStore((s) => s.prependMessages);
  const streaming = useStore((s) => s.streaming);
  const runState = useStore((s) => s.runState);
  const session = useStore((s) => s.session);
  const completed = session?.status === 'completed';
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = runState === 'running';
  const isStreaming = streaming.length > 0;

  // Whether the user is parked at the bottom (should auto-follow new content)
  // or scrolled up to read history (shouldn't get yanked back down).
  const nearBottomRef = useRef(true);
  const updateNearBottom = () => {
    const el = scrollRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Whether we've done the initial jump-to-bottom for the *currently open*
  // session yet. Reset whenever the session changes — Next.js may reuse this
  // component across `/s/[slug]` navigations rather than remounting it.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    didInitialScrollRef.current = false;
    nearBottomRef.current = true;
  }, [sessionId]);

  // Auto-scroll to the newest content — but only on meaningful transitions
  // (a full message landed, or streaming/running started or ended), not on
  // every individual streamed character/chunk. That would otherwise re-trigger
  // a scroll many times per second on long responses, which is itself a source
  // of visible jank independent of how many past messages there are.
  //
  // The very first time a session's messages load, jump straight to the
  // bottom (no animation): scrollTo({behavior:'smooth'}) sweeps scrollTop
  // through every intermediate value on the way down, including values under
  // LOAD_EARLIER_THRESHOLD_PX — which would spuriously fire the "load earlier
  // messages" logic below mid-animation and land the view mid-history instead
  // of at the latest message. useLayoutEffect (not useEffect) so this happens
  // before paint — no visible flash of the wrong scroll position.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!didInitialScrollRef.current) {
      if (messages.length === 0) return; // wait for the initial page to actually load
      el.scrollTop = el.scrollHeight;
      didInitialScrollRef.current = true;
      return;
    }
    if (nearBottomRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, isStreaming, running]);

  const loadEarlier = async () => {
    if (loadingEarlier || !hasMoreMessages || messages.length === 0) return;
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setLoadingEarlier(true);
    try {
      const res = await api.earlierMessages(sessionId, messages[0].id);
      prependMessages(res.messages, res.hasMore);
      // The list just grew above the fold — re-anchor the scroll position to
      // where the user was, instead of jumping to wherever the new top is.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      });
    } catch {
      // transient — the user can just scroll up again to retry
    } finally {
      setLoadingEarlier(false);
    }
  };

  // Search-hit jump: once the initial page has landed, page back until the
  // target message is loaded, then center it and flash a highlight.
  const [jumpMissing, setJumpMissing] = useState(false);
  const jumpedRef = useRef<string | null>(null);
  const loadedSessionId = useStore((s) => s.sessionId);
  useEffect(() => {
    if (!focusMessageId || jumpedRef.current === focusMessageId || messages.length === 0) return;
    // Next.js can reuse this component across sessions; wait until the store
    // actually holds this session's messages before paging through them.
    if (loadedSessionId !== sessionId) return;
    jumpedRef.current = focusMessageId;
    let cancelled = false;
    // Don't let the auto-follow snap back to the bottom as older pages land.
    nearBottomRef.current = false;
    (async () => {
      let st = useStore.getState();
      for (let page = 0; page < MAX_JUMP_PAGES; page++) {
        if (st.messages.some((m) => m.id === focusMessageId) || !st.hasMoreMessages) break;
        const res = await api.earlierMessages(sessionId, st.messages[0]!.id).catch(() => null);
        if (cancelled || !res) return;
        st.prependMessages(res.messages, res.hasMore);
        st = useStore.getState();
      }
      if (cancelled) return;
      // Let React paint the prepended pages before looking for the element.
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(
          `[data-msg-id="${CSS.escape(focusMessageId)}"]`,
        );
        if (!el) {
          setJumpMissing(true);
          return;
        }
        nearBottomRef.current = false;
        el.classList.add('msg-flash');
        setTimeout(() => el.classList.remove('msg-flash'), 2400);
        // Long replies can be several screens tall — land on the matched words
        // themselves, not the middle of the bubble.
        const range = focusQuery ? findTextRange(el, focusQuery) : null;
        const box = scrollRef.current;
        if (range && box) {
          const r = range.getBoundingClientRect();
          const b = box.getBoundingClientRect();
          box.scrollTop += r.top - b.top - box.clientHeight / 2;
          // CSS Custom Highlight API: marks the words without touching React's DOM.
          const hl = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
          const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
          if (hl && reg) reg.set('search-hit', new hl(range));
        } else {
          el.scrollIntoView({ block: el.offsetHeight > (box?.clientHeight ?? 0) ? 'start' : 'center' });
        }
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, messages.length > 0, sessionId, loadedSessionId]);

  const onScroll = () => {
    updateNearBottom();
    // Guard with didInitialScrollRef too: don't treat the initial landing (or
    // any programmatic jump) as the user scrolling up to browse history.
    if (
      didInitialScrollRef.current &&
      scrollRef.current &&
      scrollRef.current.scrollTop < LOAD_EARLIER_THRESHOLD_PX
    ) {
      void loadEarlier();
    }
  };

  // One column width for the transcript and the composer, so their edges line up.
  const column = 'mx-auto w-full max-w-3xl 2xl:max-w-4xl';

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-w-0 flex-1 flex-col">
      <RunConfigBar sessionId={sessionId} />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-area min-h-0 flex-1 overflow-x-hidden px-3 py-5 [scrollbar-gutter:stable_both-edges] sm:px-4 sm:py-6"
      >
        <div className={column}>
          {jumpMissing && (
            <div className="pb-3 text-center text-xs text-muted">没找到搜索结果对应的那条消息，可能已被删除</div>
          )}
          {hasMoreMessages && (
            <div className="pb-3 text-center text-xs text-muted">
              {loadingEarlier ? '正在加载更早的消息…' : '上滑加载更早的消息'}
            </div>
          )}
          <MessageList messages={messages} streaming={streaming} running={running} />
        </div>
      </div>
      <div className="pb-safe shrink-0 border-t border-border bg-bg px-3 pt-3 sm:px-4">
        <div className={`${column} space-y-3`}>
          <QuestionDock sessionId={sessionId} />
          <Composer sessionId={sessionId} disabled={completed} />
        </div>
      </div>
    </div>
  );
}
