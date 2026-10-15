'use client';
// Блоки ровно по ТЗ владельца (13.10) — одни и те же для клиента и для объекта
// («те же самые поля, но конкретно по этому объекту»). Аудит ТЗ↔реальность 14.10:
// при редизайне по Fable показатели а–ж ужались до «отгружено/вчера/в работе»,
// формат «8 / 10» и слово LTV пропали, список сделок потерял вид «как на скрине».
//   а) Отгружено / всего сделок — «8 / 10»
//   б) LTV — сумма отгруженных
//   в) Средний чек отгрузок
//   г) Цикл повторки — среднее время между отгрузками
//   д) Последняя отгрузка — дата (и дней с неё в скобках)
//   ж) Количество объектов (для клиента)
//   h) Список сделок «как на скрине»: дата, товарные группы, ↓ интервал между
//      отгрузками, сумма; стрелка раскрывает все товары сделки.

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtMoney, dealBitrixUrl } from '@/features/customers/ui/shared';
import { type ModuleDeal, type ModuleStats } from '../engine/types';
import { Chip, fmtD, dealTitle } from './parts';
import { callTiming } from '../engine/callTiming';

const DAY_MS = 86_400_000;

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5">
      <div className="text-[12px] leading-snug text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 whitespace-nowrap text-[18px] font-bold leading-tight tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

/** Показатели а–ж (ж — только у клиента: `objects`). */
export function TzMetrics({ s, objects, deals }: { s: ModuleStats; objects?: { total: number; active: number }; deals?: ModuleDeal[] }) {
  const other = s.total - s.shipped;
  const timing = deals ? callTiming(deals) : null;
  const cycle = timing?.cycle ?? s.cycleDays;
  return (
    // Плитки сами раскладываются по ширине (во вкладке Битрикса она разная): не
    // меньше 150px, без обрезки подписей «Средний чек отгруз…».
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
      <Metric label="Отгружено / всего" value={<>{s.shipped} / {s.total}</>} sub={other > 0 ? `${other} в других статусах` : 'все отгружены'} />
      <Metric label="LTV" value={fmtMoney(s.ltv)} sub={s.firstShippedAt ? `с ${fmtD(s.firstShippedAt)}` : 'отгрузок нет'} />
      <Metric label="Средний чек отгрузки" value={s.avgCheck !== null ? fmtMoney(s.avgCheck) : '—'} />
      {/* Одно число цикла на весь экран (аудит 15.10: плитка «9 дн.» спорила со строкой
          «раз в 8 дней»): при 3+ покупках — медиана из callTiming, иначе среднее ТЗ. */}
      <Metric label="Цикл повторки" value={cycle !== null ? `${cycle} дн.` : '—'} sub={timing ? `обычно, по ${timing.purchases} покупкам` : s.cycleDays !== null ? 'между отгрузками' : 'нужно 2+ отгрузки'} />
      <Metric label="Последняя отгрузка" value={s.lastShippedAt ? fmtD(s.lastShippedAt) : '—'}
        sub={s.daysSinceLast !== null ? `(${s.daysSinceLast} дн. назад)` : undefined} />
      {objects && <Metric label="Объектов" value={objects.total} sub={`в работе ${objects.active}`} />}
    </div>
  );
}

/** h) «Покупки» — отгруженные сделки как на скрине ТЗ: по хронологии, ↓ интервал
 *  от предыдущей отгрузки, стрелка раскрывает все товары сделки. */
export function Purchases({ deals, title = 'Покупки' }: { deals: ModuleDeal[]; title?: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const list = useMemo(() => deals.filter(d => d.deliveredAt).sort((a, b) => a.deliveredAt!.localeCompare(b.deliveredAt!) || a.dealId - b.dealId), [deals]);
  const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title} · {list.length}</div>
      {list.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Отгрузок нет</div> : (
        <div className="flex flex-col divide-y divide-[var(--color-border)]">
          {list.map((d, i) => {
            const gap = i > 0 ? Math.round((new Date(d.deliveredAt!).getTime() - new Date(list[i - 1].deliveredAt!).getTime()) / DAY_MS) : null;
            const isOpen = open.has(d.dealId);
            const total = d.products.reduce((s, p) => s + p.sum, 0);
            return (
              <div key={d.dealId}>
                <button type="button" onClick={() => toggle(d.dealId)} aria-expanded={isOpen}
                  className="flex w-full items-center gap-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--color-bg-hover)]">
                  <span className="shrink-0 text-[var(--color-text-muted)]">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                  <span className="w-[62px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtD(d.deliveredAt)}</span>
                  <span className="min-w-0 flex-1 truncate" title={d.groups.join(', ')}>{d.groups.length ? d.groups.join(', ') : dealTitle(d)}</span>
                  {gap !== null && <Chip>↓ {gap} дн.</Chip>}
                  <span className="w-[76px] shrink-0 text-right font-semibold tabular-nums">{d.amount > 0 ? fmtMoney(d.amount) : '—'}</span>
                </button>
                {isOpen && (
                  <div className="mb-1.5 ml-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
                    {d.products.length === 0 ? <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">В сделке нет товарных позиций</div>
                      : d.products.map((p, j) => (
                        <div key={j} className={`flex flex-wrap items-baseline gap-x-3 px-3 py-1.5 text-[12px] ${j > 0 ? 'border-t border-[var(--color-border)]' : ''}`}>
                          <span className="min-w-0 flex-1 basis-[200px] break-words">{p.name}</span>
                          <span className="tabular-nums text-[var(--color-text-muted)]">{p.quantity.toLocaleString('ru-RU')} × {fmtMoney(p.price)}</span>
                          <span className="ml-auto font-medium tabular-nums">{fmtMoney(p.sum)}</span>
                        </div>
                      ))}
                    <div className="flex flex-wrap gap-x-3 border-t border-[var(--color-border)] px-3 py-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                      <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">{dealTitle(d)} — открыть в Битриксе</a>
                      {d.managerName && <span>· {d.managerName}</span>}
                      {d.products.length > 0 && <span className="ml-auto">Итого: <b className="tabular-nums text-[var(--color-text)]">{fmtMoney(total)}</b></span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
