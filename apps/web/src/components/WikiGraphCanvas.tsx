'use client';
import { useEffect, useRef } from 'react';
import type { KnowledgeKind, WikiGraphResponse } from '@chapi/shared';
import { cssToken } from '@/lib/theme';

/** Same colors the server writes into the Obsidian graph's color groups. */
export const KIND_COLORS: Record<KnowledgeKind, string> = { skill: '#3b82f6', preference: '#3fb950', data: '#d29922' };
/** Negative preferences ("don't do X") are drawn fully red. */
export const NEGATIVE_COLOR = '#f85149';
const KIND_ORDER: KnowledgeKind[] = ['skill', 'preference', 'data'];

export function nodeColor(kind: KnowledgeKind, polarity?: string): string {
  return kind === 'preference' && polarity === 'negative' ? NEGATIVE_COLOR : KIND_COLORS[kind];
}

interface SimNode {
  id: string;
  title: string;
  kind: KnowledgeKind;
  /** Primary content category — the main grouping. */
  topic: string;
  score: number;
  polarity: string;
  /** 0.08..1 from the score (squared) — drives size and pull. */
  mass: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

const radiusOf = (n: SimNode) => 3 + n.mass * 19;

/** Content categories placed on rings (biggest first); each kind sits a little apart inside its category. */
function topicAnchors(topics: string[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  let i = 0;
  let ring = 0;
  while (i < topics.length) {
    const cap = ring === 0 ? 1 : 6 * ring + 2;
    const r = ring * 520;
    const n = Math.min(cap, topics.length - i);
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + ring * 0.6;
      out.set(topics[i + j]!, { x: Math.cos(a) * r * 1.15, y: Math.sin(a) * r });
    }
    i += n;
    ring += 1;
  }
  return out;
}

const KIND_OFFSET: Record<KnowledgeKind, { x: number; y: number }> = Object.fromEntries(
  KIND_ORDER.map((k, i) => {
    const a = -Math.PI / 2 + (i / KIND_ORDER.length) * Math.PI * 2;
    return [k, { x: Math.cos(a) * 70, y: Math.sin(a) * 70 }];
  }),
) as Record<KnowledgeKind, { x: number; y: number }>;

/**
 * Force-directed knowledge graph on a canvas:
 *  - grouped first by content category (website / project …), then by kind inside it
 *  - node size = weight / confidence; within a category nodes are pulled toward the
 *    heavier ones, so strong knowledge becomes a hub; other categories are pushed away
 *  - negative preferences are fully red; [[links]] are springs
 *  - drag nodes, drag background to pan, wheel to zoom
 */
/** The UI's text face (canvas can't read CSS variables for fonts). */
const CANVAS_FONT = "'IBM Plex Sans', 'Noto Sans SC', system-ui, sans-serif";

export function WikiGraphCanvas({
  graph,
  shown,
  highlight,
  selectedId,
  onSelect,
}: {
  graph: WikiGraphResponse;
  /** Node ids that pass the filters (null = everything). */
  shown: Set<string> | null;
  /** Node ids matching the search box (others dim). null = no search. */
  highlight: Set<string> | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    nodes: [] as SimNode[],
    byId: new Map<string, SimNode>(),
    links: [] as Array<{ s: SimNode; t: SimNode }>,
    neighbors: new Map<string, Set<string>>(),
    anchors: new Map<string, { x: number; y: number }>(),
    alpha: 1,
    view: { x: 0, y: 0, k: 0.45 },
    hover: null as SimNode | null,
    drag: null as null | { node: SimNode | null; sx: number; sy: number; vx: number; vy: number; moved: boolean },
    w: 800,
    h: 600,
    /** Set when the selection came from a click on the canvas itself (don't re-center). */
    skipCenter: false,
  });
  const props = useRef({ shown, highlight, selectedId, onSelect });
  props.current = { shown, highlight, selectedId, onSelect };

  // (Re)build the simulation when the graph changes, keeping positions of known nodes.
  useEffect(() => {
    const st = state.current;
    const prev = st.byId;
    st.anchors = topicAnchors(graph.topics.map((t) => t.name).concat(graph.nodes.some((n) => !n.topics?.length) ? ['未分类'] : []));
    st.nodes = graph.nodes.map((n) => {
      const p = prev.get(n.id);
      const kind = (n.kind ?? 'skill') as KnowledgeKind;
      const topic = n.topics?.[0] || '未分类';
      const a = st.anchors.get(topic) ?? { x: 0, y: 0 };
      return {
        id: n.id,
        title: n.title,
        kind,
        topic,
        score: n.score,
        polarity: n.polarity,
        // squared so the usual 50–80 range still shows clearly different sizes
        mass: 0.08 + 0.92 * Math.pow(Math.max(0, Math.min(100, n.score)) / 100, 2),
        x: p?.x ?? a.x + KIND_OFFSET[kind].x + (Math.random() - 0.5) * 120,
        y: p?.y ?? a.y + KIND_OFFSET[kind].y + (Math.random() - 0.5) * 120,
        vx: 0,
        vy: 0,
        fixed: false,
      };
    });
    st.byId = new Map(st.nodes.map((n) => [n.id, n]));
    st.links = graph.links
      .map((l) => ({ s: st.byId.get(l.source)!, t: st.byId.get(l.target)! }))
      .filter((l) => l.s && l.t);
    st.neighbors = new Map(st.nodes.map((n) => [n.id, new Set<string>()]));
    for (const l of st.links) {
      st.neighbors.get(l.s.id)!.add(l.t.id);
      st.neighbors.get(l.t.id)!.add(l.s.id);
    }
    st.alpha = 1;
  }, [graph]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d')!;
    const st = state.current;
    let raf = 0;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      st.w = r.width;
      st.h = r.height;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const visible = (n: SimNode) => !props.current.shown || props.current.shown.has(n.id);

    const step = () => {
      const a = st.alpha;
      if (a < 0.002) return;
      const nodes = st.nodes.filter(visible);
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const q = nodes[j]!;
          let dx = q.x - p.x;
          let dy = q.y - p.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          if (d2 > 1_440_000) continue;
          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          const sameTopic = p.topic === q.topic;
          const minGap = radiusOf(p) + radiusOf(q) + 8;
          // repulsion: mild inside a category (a little more between kinds), strong between categories
          let f = ((sameTopic ? (p.kind === q.kind ? 1800 : 3200) : 8000) * a) / d2;
          if (d < minGap) f += (minGap - d) * 0.25; // no overlap
          p.vx -= ux * f;
          p.vy -= uy * f;
          q.vx += ux * f;
          q.vy += uy * f;
          if (sameTopic && d > minGap) {
            // same category: each node is pulled toward heavier ones (strong knowledge becomes a hub)
            const pull = 0.0005 * a * d * (p.kind === q.kind ? 1 : 0.5);
            p.vx += ux * pull * q.mass * q.mass * (1.1 - p.mass);
            p.vy += uy * pull * q.mass * q.mass * (1.1 - p.mass);
            q.vx -= ux * pull * p.mass * p.mass * (1.1 - q.mass);
            q.vy -= uy * pull * p.mass * p.mass * (1.1 - q.mass);
          }
        }
      }
      for (const l of st.links) {
        if (!visible(l.s) || !visible(l.t)) continue;
        const dx = l.t.x - l.s.x;
        const dy = l.t.y - l.s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const same = l.s.topic === l.t.topic;
        // cross-category links stay visible but barely pull, so clusters don't collapse into each other
        const f = (d - (same ? 90 : 420)) * (same ? 0.006 : 0.0003) * a;
        l.s.vx += (dx / d) * f;
        l.s.vy += (dy / d) * f;
        l.t.vx -= (dx / d) * f;
        l.t.vy -= (dy / d) * f;
      }
      for (const n of nodes) {
        const an = st.anchors.get(n.topic) ?? { x: 0, y: 0 };
        const ko = KIND_OFFSET[n.kind];
        n.vx += (an.x + ko.x - n.x) * 0.014 * a;
        n.vy += (an.y + ko.y - n.y) * 0.014 * a;
        if (!n.fixed) {
          n.x += n.vx;
          n.y += n.vy;
        }
        n.vx *= 0.58;
        n.vy *= 0.58;
      }
      st.alpha *= 0.988;
    };

    const draw = () => {
      // Theme-aware ink, read once per frame (a light/dark switch shows at once
      // without a style recalc for every link and label).
      const inkBase = cssToken('text', 1);
      const muteBase = cssToken('muted', 1);
      const ink = (a: number) => inkBase.replace(/ \/ [\d.]+\)$/, ` / ${a})`);
      const mute = (a: number) => muteBase.replace(/ \/ [\d.]+\)$/, ` / ${a})`);
      const { x: ox, y: oy, k } = st.view;
      const { highlight: hl, selectedId: sel } = props.current;
      ctx.clearRect(0, 0, st.w, st.h);
      ctx.save();
      ctx.translate(st.w / 2 + ox, st.h / 2 + oy);
      ctx.scale(k, k);
      const focus = st.hover ?? (sel ? st.byId.get(sel) ?? null : null);
      const near = focus ? st.neighbors.get(focus.id) ?? new Set<string>() : null;
      const lit = (n: SimNode) => (hl ? hl.has(n.id) : true) && (!near || n.id === focus!.id || near.has(n.id));
      const order = st.nodes.filter(visible).sort((p, q) => p.mass - q.mass);

      // category labels at each cluster's centroid (behind everything)
      const cent = new Map<string, { x: number; y: number; n: number; top: number }>();
      for (const n of order) {
        const c = cent.get(n.topic) ?? { x: 0, y: 0, n: 0, top: Infinity };
        c.x += n.x;
        c.y += n.y;
        c.n += 1;
        c.top = Math.min(c.top, n.y - radiusOf(n));
        cent.set(n.topic, c);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = `500 ${16 / Math.max(k, 0.35)}px ${CANVAS_FONT}`;
      ctx.fillStyle = ink(0.38);
      for (const [t, c] of cent) if (c.n >= 2) ctx.fillText(`${t} · ${c.n}`, c.x / c.n, c.top - 12 / k);

      for (const l of st.links) {
        if (!visible(l.s) || !visible(l.t)) continue;
        const on = focus && (l.s.id === focus.id || l.t.id === focus.id);
        ctx.strokeStyle = on ? ink(0.75) : lit(l.s) && lit(l.t) ? mute(0.28) : mute(0.06);
        ctx.lineWidth = (on ? 1.6 : 1) / k;
        ctx.beginPath();
        ctx.moveTo(l.s.x, l.s.y);
        ctx.lineTo(l.t.x, l.t.y);
        ctx.stroke();
      }
      for (const n of order) {
        const r = radiusOf(n);
        ctx.globalAlpha = lit(n) ? 1 : 0.12;
        ctx.fillStyle = nodeColor(n.kind, n.polarity);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (n.id === sel) {
          ctx.strokeStyle = ink(0.9);
          ctx.lineWidth = 2.4 / k;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3 / k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // node labels: hovered/selected + neighbors, search hits, the heaviest hubs, or everything when zoomed in
      const hubCut = order.map((n) => n.mass).sort((p, q) => q - p)[11] ?? 2;
      ctx.textBaseline = 'top';
      for (const n of order) {
        const show =
          k > 1.3 ||
          n.id === focus?.id ||
          n.id === sel ||
          (near?.has(n.id) ?? false) ||
          (hl?.has(n.id) ?? false) ||
          (!focus && !hl && n.mass >= hubCut && k > 0.5);
        if (!show) continue;
        ctx.globalAlpha = lit(n) ? 0.95 : 0.25;
        ctx.font = `${(n.mass > 0.5 ? 13 : 11.5) / Math.max(k, 0.5)}px ${CANVAS_FONT}`;
        ctx.fillStyle = ink(1);
        const label = n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title;
        ctx.fillText(label, n.x, n.y + radiusOf(n) + 3 / k);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    // Reduced motion: no visible settling — run the layout to rest in one go.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const loop = () => {
      if (still.matches && !st.drag) for (let i = 0; i < 400 && st.alpha >= 0.002; i++) step();
      else step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const toWorld = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect();
      const { x, y, k } = st.view;
      return { x: (cx - r.left - st.w / 2 - x) / k, y: (cy - r.top - st.h / 2 - y) / k };
    };
    const pick = (cx: number, cy: number): SimNode | null => {
      const p = toWorld(cx, cy);
      let best: SimNode | null = null;
      let bd = Infinity;
      for (const n of st.nodes) {
        if (!visible(n)) continue;
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < radiusOf(n) + 4 / st.view.k && d < bd) {
          best = n;
          bd = d;
        }
      }
      return best;
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const node = pick(e.clientX, e.clientY);
      st.drag = { node, sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false };
      if (node) node.fixed = true;
    };
    const onMove = (e: PointerEvent) => {
      const d = st.drag;
      if (!d) {
        const h = pick(e.clientX, e.clientY);
        if (h !== st.hover) st.hover = h;
        canvas.style.cursor = h ? 'pointer' : 'grab';
        return;
      }
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      if (d.node) {
        const p = toWorld(e.clientX, e.clientY);
        d.node.x = p.x;
        d.node.y = p.y;
        st.alpha = Math.max(st.alpha, 0.3);
      } else {
        st.view.x = d.vx + (e.clientX - d.sx);
        st.view.y = d.vy + (e.clientY - d.sy);
        canvas.style.cursor = 'grabbing';
      }
    };
    const onUp = () => {
      const d = st.drag;
      st.drag = null;
      if (!d) return;
      if (d.node) d.node.fixed = false;
      if (!d.moved) {
        st.skipCenter = true;
        props.current.onSelect(d.node ? d.node.id : null);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left - st.w / 2;
      const my = e.clientY - r.top - st.h / 2;
      const k0 = st.view.k;
      const k1 = Math.min(4, Math.max(0.1, k0 * Math.exp(-e.deltaY * 0.0015)));
      st.view.x = mx - ((mx - st.view.x) * k1) / k0;
      st.view.y = my - ((my - st.view.y) * k1) / k0;
      st.view.k = k1;
    };
    const onLeave = () => (st.hover = null);

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Selecting from outside (list/search/wikilink): center the view on that node.
  useEffect(() => {
    if (state.current.skipCenter) {
      state.current.skipCenter = false;
      return;
    }
    if (!selectedId) return;
    const n = state.current.byId.get(selectedId);
    if (!n) return;
    const v = state.current.view;
    v.x = -n.x * v.k;
    v.y = -n.y * v.k;
  }, [selectedId]);

  // Filters changed: re-heat, and when only a subset is shown, frame it.
  useEffect(() => {
    const st = state.current;
    st.alpha = Math.max(st.alpha, 0.5);
    if (!shown || !shown.size) return;
    const vis = st.nodes.filter((n) => shown.has(n.id));
    if (!vis.length) return;
    const xs = vis.map((n) => n.x);
    const ys = vis.map((n) => n.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 300);
    st.view.k = Math.min(1.4, Math.max(0.2, (Math.min(st.w, st.h) * 0.8) / span));
    st.view.x = -cx * st.view.k;
    st.view.y = -cy * st.view.k;
  }, [shown]);

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`知识图谱：${graph.nodes.length} 个知识点、${graph.links.length} 条链接。用键盘可在「列表」页浏览同样的内容`}
        className="block touch-none"
      />
    </div>
  );
}
