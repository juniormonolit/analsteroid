// Клиентская математика «Карты показателей»: индекс дерева, «что если», форматирование.
// Контракт — features/metric-map/types.ts. Движок присылает уже посчитанные значения;
// здесь только пересчёт сценария «поменял множитель → что с корнем».
import type { MapNodeDef, MapUnit, MetricMapResponse } from '../types';

export interface TreeIndex {
  byId: Map<string, MapNodeDef>;
  parentOf: Map<string, string>;
}

export function indexTree(data: Pick<MetricMapResponse, 'nodes'>): TreeIndex {
  const byId = new Map(data.nodes.map(n => [n.id, n]));
  const parentOf = new Map<string, string>();
  for (const n of data.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  return { byId, parentOf };
}

/** Узел можно двигать в «что если», если он — множитель (ребёнок product-узла). */
export function isMultiplier(idx: TreeIndex, id: string): boolean {
  const p = idx.parentOf.get(id);
  return !!p && idx.byId.get(p)?.kind === 'product';
}

/**
 * Значения дерева при сценарии `overrides` (id → новое значение).
 *
 * Считаем ПРИРАЩЕНИЯМИ от факта, а не заново Σ/Π детей: факт узла может отличаться от
 * собранного по детям на невязку (residual), и без сценария дерево обязано показывать
 * ровно то, что прислал движок. sum: new = fact + Σ(newChild − child);
 * product: new = fact × Π(newChild / child). Факторы считаются независимыми
 * (поднял CR — сделок столько же), это явная оговорка в интерфейсе.
 */
export function scenarioValues(
  data: Pick<MetricMapResponse, 'rootId' | 'nodes' | 'values'>,
  idx: TreeIndex,
  overrides: Record<string, number>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const visit = (id: string): number | null => {
    if (id in out) return out[id];
    const def = idx.byId.get(id);
    const fact = data.values[id]?.value ?? null;
    let v: number | null = fact;
    if (id in overrides) {
      v = overrides[id];
    } else if (def && fact != null && def.children?.length) {
      if (def.kind === 'sum') {
        let d = 0;
        for (const c of def.children) {
          const cv = visit(c);
          const cf = data.values[c]?.value ?? null;
          if (cv != null && cf != null) d += cv - cf;
        }
        v = fact + d;
      } else if (def.kind === 'product') {
        let k = 1;
        for (const c of def.children) {
          const cv = visit(c);
          const cf = data.values[c]?.value ?? null;
          if (cv != null && cf != null && cf !== 0) k *= cv / cf;
        }
        v = fact * k;
      } else {
        for (const c of def.children) visit(c);
      }
    } else if (def?.children) {
      for (const c of def.children) visit(c);
    }
    out[id] = v;
    return v;
  };
  visit(data.rootId);
  return out;
}

// ── Форматирование ─────────────────────────────────────────────────────────

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

export function fmtRub(v: number, signed = false): string {
  const s = signed && v > 0 ? '+' : v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${s}${nf2.format(a / 1e6)} млн ₽`;
  if (a >= 1e4) return `${s}${nf0.format(a / 1e3)} тыс. ₽`;
  return `${s}${nf0.format(a)} ₽`;
}

export function fmtValue(v: number | null | undefined, unit: MapUnit): string {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'rub': return fmtRub(v);
    case 'count': return nf0.format(v);
    case 'pct': return `${nf1.format(v * 100)}%`;
    case 'ratio': return nf2.format(v);
  }
}

/** Изменение к периоду сравнения: для долей — в п.п., для остального — в %. */
export function fmtDelta(v: number | null, prev: number | null, unit: MapUnit): { text: string; sign: -1 | 0 | 1 } | null {
  if (v == null || prev == null) return null;
  if (unit === 'pct') {
    const d = (v - prev) * 100;
    if (Math.abs(d) < 0.05) return { text: '0 п.п.', sign: 0 };
    return { text: `${d > 0 ? '+' : '−'}${nf1.format(Math.abs(d))} п.п.`, sign: d > 0 ? 1 : -1 };
  }
  if (prev === 0) return null;
  const d = (v / prev - 1) * 100;
  if (Math.abs(d) < 0.05) return { text: '0%', sign: 0 };
  return { text: `${d > 0 ? '+' : '−'}${nf1.format(Math.abs(d))}%`, sign: d > 0 ? 1 : -1 };
}

/** Пределы ползунка «что если» вокруг факта. */
export function sliderRange(value: number, unit: MapUnit, median: number | null): { min: number; max: number; step: number } {
  if (unit === 'pct') {
    const hi = Math.min(1, Math.max(value * 2, (median ?? 0) * 1.3, value + 0.1));
    return { min: 0, max: Math.round(hi * 1000) / 1000, step: 0.001 };
  }
  const base = Math.max(value, median ?? 0);
  const max = base * 2 || 1;
  const step = unit === 'count' ? 1 : unit === 'ratio' ? 0.01 : Math.max(1, Math.round(max / 500));
  return { min: 0, max, step };
}

/** Значение для поля ввода «что если»: доли — в процентах. */
export const toInput = (v: number, unit: MapUnit) => unit === 'pct' ? Math.round(v * 1000) / 10 : unit === 'ratio' ? Math.round(v * 100) / 100 : Math.round(v);
export const fromInput = (v: number, unit: MapUnit) => unit === 'pct' ? v / 100 : v;
