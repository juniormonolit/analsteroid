'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { metricFormulaLine } from '@/lib/metrics/formulaText';
import type { Metric } from '@/lib/metrics/types';

// Тело поповера «?» у метрики — общее для панели метрик (MetricPanel) и шапки
// колонки отчёта (ReportTable). Задача владельца 24.08: по «имени метрики» в
// формуле можно ПРОВАЛИТЬСЯ — прочитать, как считается ОНА, и вернуться назад.
//
// Имена в формулах размечены кавычками-ёлочками («…») — так пишет и
// автогенерация каталога (catalog.ts), и ручные formula_human (миграция 185).
// Сопоставление с каталогом — по точному имени, иначе по началу имени с
// границей слова: ручные формулы сокращают хвосты («Купившие повторно» ↔
// «Купившие повторно (кол-во)»), а автогенерация отрезает « (служебная)».
// При нескольких кандидатах побеждает самое короткое имя — «Купившие повторно»
// не должно уводить в «Купившие повторно другую категорию (кол-во)».

function resolveQuotedRaw(q: string, all: Metric[], selfId: string): Metric | null {
  let best: Metric | null = null;
  for (const m of all) {
    if (m.id === selfId) continue;
    const n = m.nameRu;
    const exact = n === q;
    const prefix = !exact && n.startsWith(q) && ' (,'.includes(n.charAt(q.length));
    if (!exact && !prefix) continue;
    if (exact) return m;
    if (!best || n.length < best.nameRu.length) best = m;
  }
  return best;
}

function resolveQuoted(q: string, all: Metric[], selfId: string): Metric | null {
  const direct = resolveQuotedRaw(q, all, selfId);
  if (direct) return direct;
  // Ссылка посреди фразы пишется со строчной («…из "должны были получить
  // звонок"…»), а имя метрики — с заглавной. Пробуем поднять первую букву.
  const up = q.charAt(0).toUpperCase() + q.slice(1);
  return up !== q ? resolveQuotedRaw(up, all, selfId) : null;
}

/** Формула с кликабельными именами метрик. Сегменты вне «…» — как есть. */
function FormulaLine({ line, all, selfId, onOpen }: {
  line: string; all: Metric[]; selfId: string; onOpen: (m: Metric) => void;
}) {
  const parts = useMemo(() => line.split(/(«[^»]+»)/g), [line]);
  return (
    <span className="font-mono">
      {parts.map((p, i) => {
        const m = p.startsWith('«') && p.endsWith('»')
          ? resolveQuoted(p.slice(1, -1), all, selfId)
          : null;
        if (!m) return <span key={i}>{p}</span>;
        return (
          <button
            key={i}
            onClick={e => { e.stopPropagation(); onOpen(m); }}
            title={`Как считается «${m.nameRu}»`}
            className="text-[var(--color-accent)] underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer"
          >
            {p}
          </button>
        );
      })}
    </span>
  );
}

export function MetricInfoBody({ metric }: { metric: Metric }) {
  // Стек проваливаний; вершина — то, что показываем. Radix размонтирует контент
  // при закрытии поповера, так что каждый открытый «?» начинает с чистого стека;
  // сброс по смене корневой метрики — страховка на случай переиспользования.
  const [stack, setStack] = useState<Metric[]>([]);
  useEffect(() => { setStack([]); }, [metric.id]);
  const current = stack[stack.length - 1] ?? metric;

  // Полный каталог — для резолва имён в формуле: зависимости формулы могут быть
  // не выбраны в отчёт. Тот же ключ, что в SalesReportPage, — кэш общий.
  const { data } = useQuery({
    queryKey: ['metrics-catalog'],
    queryFn: async () => {
      const res = await fetch('/api/catalog/metrics');
      if (!res.ok) throw new Error('Failed to load metrics catalog');
      return res.json() as Promise<{ metrics: Metric[] }>;
    },
    staleTime: 5 * 60 * 1000,
  });
  const all = data?.metrics ?? [];

  const text = current.humanDescription || current.description;
  const formula = metricFormulaLine(current);

  return (
    <>
      {stack.length > 0 && (
        <button
          onClick={e => { e.stopPropagation(); setStack(s => s.slice(0, -1)); }}
          className="tap-target mb-1 flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
        >
          <ArrowLeft size={11} />
          Назад к «{(stack[stack.length - 2] ?? metric).nameRu}»
        </button>
      )}
      <div className="text-sm font-semibold text-[var(--color-text)] mb-1.5">{current.nameRu}</div>
      {text && (
        <div className="text-xs leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">{text}</div>
      )}
      {formula && (
        <div className="mt-2 pt-2 border-t border-[var(--color-border)] text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          <span className="font-semibold">Формула:</span>{' '}
          <FormulaLine line={formula} all={all} selfId={current.id} onOpen={m => setStack(s => [...s, m])} />
        </div>
      )}
    </>
  );
}
