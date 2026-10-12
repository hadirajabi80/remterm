import type { Layout } from './types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  key: string; // split node key
  dir: 'row' | 'col';
  rect: Rect; // the split node's area, for drag math
  at: number; // boundary position in % of the tab (x for row, y for col)
}

export function leaves(l: Layout): string[] {
  return l.type === 'pane' ? [l.key] : [...leaves(l.a), ...leaves(l.b)];
}

/** Replaces pane `target` with a split of [target, added] (or [added, target] when before). */
export function splitPane(l: Layout, target: string, added: string, dir: 'row' | 'col', splitKey: string): Layout {
  if (l.type === 'pane') {
    if (l.key !== target) return l;
    return { type: 'split', key: splitKey, dir, ratio: 0.5, a: l, b: { type: 'pane', key: added } };
  }
  return { ...l, a: splitPane(l.a, target, added, dir, splitKey), b: splitPane(l.b, target, added, dir, splitKey) };
}

/** Removes a pane; its sibling takes the parent's place. Returns null when the tree is empty. */
export function removePane(l: Layout, key: string): Layout | null {
  if (l.type === 'pane') return l.key === key ? null : l;
  const a = removePane(l.a, key);
  const b = removePane(l.b, key);
  if (!a) return b;
  if (!b) return a;
  return { ...l, a, b };
}

export function setRatio(l: Layout, splitKey: string, ratio: number): Layout {
  if (l.type === 'pane') return l;
  if (l.key === splitKey) return { ...l, ratio };
  return { ...l, a: setRatio(l.a, splitKey, ratio), b: setRatio(l.b, splitKey, ratio) };
}

/** Pane rectangles and divider positions, in % of the tab area. */
export function computeLayout(l: Layout, r: Rect = { x: 0, y: 0, w: 100, h: 100 }) {
  const panes = new Map<string, Rect>();
  const dividers: Divider[] = [];
  const walk = (n: Layout, rect: Rect) => {
    if (n.type === 'pane') {
      panes.set(n.key, rect);
      return;
    }
    if (n.dir === 'row') {
      const wa = rect.w * n.ratio;
      walk(n.a, { ...rect, w: wa });
      walk(n.b, { ...rect, x: rect.x + wa, w: rect.w - wa });
      dividers.push({ key: n.key, dir: 'row', rect, at: rect.x + wa });
    } else {
      const ha = rect.h * n.ratio;
      walk(n.a, { ...rect, h: ha });
      walk(n.b, { ...rect, y: rect.y + ha, h: rect.h - ha });
      dividers.push({ key: n.key, dir: 'col', rect, at: rect.y + ha });
    }
  };
  walk(l, r);
  return { panes, dividers };
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** The pane next to `from` in a direction, preferring the one most aligned with it. */
export function neighbor(l: Layout, from: string, dir: Direction): string | null {
  const { panes } = computeLayout(l);
  const a = panes.get(from);
  if (!a) return null;
  const eps = 0.01;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [key, b] of panes) {
    if (key === from) continue;
    let touching = false;
    let overlap = 0;
    if (dir === 'left' || dir === 'right') {
      touching = dir === 'left' ? Math.abs(b.x + b.w - a.x) < eps : Math.abs(a.x + a.w - b.x) < eps;
      overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    } else {
      touching = dir === 'up' ? Math.abs(b.y + b.h - a.y) < eps : Math.abs(a.y + a.h - b.y) < eps;
      overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    }
    if (!touching || overlap <= 0) continue;
    const score = -overlap;
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best;
}
