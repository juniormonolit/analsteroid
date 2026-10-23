'use client';
// «Когда звонить» на «Обзоре» — см. engine/callTiming.ts.

import { AlarmClock } from 'lucide-react';
import { type ModuleDeal, isOpenDeal } from '../engine/types';
import { callTiming } from '../engine/callTiming';
import { fmtD } from './parts';

const dn = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'дня' : 'дней'}`;

export function CallTimingLine({ deals, bare = false }: { deals: ModuleDeal[]; bare?: boolean }) {
  const t = callTiming(deals);
  if (!t) return null;
  const open = deals.some(isOpenDeal);
  const tone = open ? 'var(--color-text-muted)' : t.state === 'overdue' ? 'var(--color-negative, #e03131)' : t.state === 'due' ? 'var(--color-warning, #e8590c)' : 'var(--color-text-muted)';
  const left = Math.round((new Date(t.nextAt).getTime() - Date.now()) / 86_400_000);
  const text =
    t.state === 'soon' ? <>Следующая покупка ожидается <b>~{fmtD(t.nextAt)}</b> — через {dn(left)}</>
    : t.state === 'due' ? <><b>Пора звонить:</b> с последней покупки {dn(t.since)}, обычно покупает раз в {dn(t.cycle)}</>
    : <><b>Давно не покупал:</b> {dn(t.since)} при обычных {t.cycle} — риск ухода, узнай, где сейчас берёт</>;
  // Сделка уже в работе — звонить незачем напоминать: тихая строка, без плашки.
  if (open) return (
    <div className="flex items-center gap-1.5 px-0.5 text-[12.5px] text-[var(--color-text-muted)]">
      <AlarmClock size={14} className="shrink-0" />
      <span className="min-w-0">Обычно покупает раз в {dn(t.cycle)} · сделка уже в работе</span>
    </div>
  );
  // bare — строка внутри блока «Сейчас» на «Обзоре» (аудит 23.10: три рамки трёх цветов → один блок).
  return (
    <div className={`flex items-start gap-2 text-[13px] leading-snug ${bare ? '' : 'rounded-xl border px-3 py-2'}`}
      style={bare ? undefined : { borderColor: `color-mix(in srgb, ${tone} 35%, transparent)`, background: `color-mix(in srgb, ${tone} 6%, transparent)` }}>
      <AlarmClock size={16} className="mt-px shrink-0" style={{ color: tone }} />
      <span className="min-w-0">{text}
        <span className="block text-[11.5px] text-[var(--color-text-muted)]">по {t.purchases} покупкам, медиана интервалов</span></span>
    </div>
  );
}
