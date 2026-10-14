'use client';
// Таб «Обзор» карточки клиента — первый экран для работы (правка владельца
// 13.10): сводка, заметки, показатели, что предложить, товарные группы и объекты.

import { MapPin } from 'lucide-react';
import { fmtMoney, fmtDate } from '@/features/customers/ui/shared';
import { type ClientModuleData, computeStats, objectStatus, EMPTY_OBJECT_PROFILE } from '../engine/types';
import { Section, Stat, RecList, ClientFields, StatusChip, shortGroup } from './parts';
import { shortAddress } from '../engine/objectClusters';

export function OverviewTab({ data, params, onOpenObject }: { data: ClientModuleData; params: Record<string, string>; onOpenObject: (key: string) => void }) {
  const stats = computeStats(data.deals);
  const groupMax = stats.groups[0]?.sum ?? 0;
  const objects = data.objects.map(o => {
    const deals = data.deals.filter(d => d.objectKey === o.key);
    const prof = data.objectProfiles[o.key] ?? EMPTY_OBJECT_PROFILE;
    const st = objectStatus(deals, { manual: o.manual, doneManual: prof.doneManual }, data.activeDays);
    const s = computeStats(deals);
    return { o, prof, st, s };
  }).sort((a, b) => ({ active: 0, new: 1, done: 2 }[a.st] - { active: 0, new: 1, done: 2 }[b.st]) || (b.s.lastShippedAt ?? '').localeCompare(a.s.lastShippedAt ?? ''));
  const activeObjects = objects.filter(x => x.st === 'active').length;

  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Отгружено / всего сделок" value={<>{stats.shipped} / {stats.total}</>} sub={stats.total - stats.shipped > 0 ? `${stats.total - stats.shipped} в других статусах` : 'все отгружены'} />
          <Stat label="LTV (сумма отгрузок)" value={fmtMoney(stats.ltv)} sub={stats.firstShippedAt ? `клиент с ${fmtDate(stats.firstShippedAt)}` : undefined} />
          <Stat label="Средний чек отгрузки" value={stats.avgCheck !== null ? fmtMoney(stats.avgCheck) : '—'} />
          <Stat label="Цикл повторки" value={stats.cycleDays !== null ? `${stats.cycleDays} дн.` : '—'} sub={stats.cycleDays !== null ? 'среднее между отгрузками' : 'нужно 2+ отгрузки'} />
          <Stat label="Последняя отгрузка" value={fmtDate(stats.lastShippedAt)} sub={stats.daysSinceLast !== null ? `${stats.daysSinceLast} дн. назад` : undefined} />
          <Stat label="В работе сейчас" value={stats.open > 0 ? `${stats.open} на ${fmtMoney(stats.openSum)}` : 'нет'} sub={`объектов: ${data.objects.length}, в работе ${activeObjects}`} />
        </div>

        <Section title="Что предложить клиенту">
          <RecList recs={data.recommendations.client} empty="Отгрузок ещё не было — предложить по истории нечего." />
          <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">По цепочке стройки (майндкарта), истории переходов по базе и приоритетам «Что предложить». По каждому объекту — во вкладке «Объекты».</div>
        </Section>

        <Section title={`Товарные группы по отгрузкам · ${stats.groups.length}`}>
          {stats.groups.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Отгрузок с товарами нет</div> : (
            <div className="flex flex-col gap-1.5">
              {stats.groups.map(g => (
                <div key={g.group} className="text-[12.5px]">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate" title={g.group}>{g.group}</span>
                    <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{g.deals} отгр. · посл. {fmtDate(g.lastAt)}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{fmtMoney(g.sum)}</span>
                  </div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-hover)]">
                    <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${groupMax > 0 ? Math.max(2, (g.sum / groupMax) * 100) : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <ClientFields data={data} params={params} />
        <Section title={`Объекты · ${data.objects.length}`}>
          {objects.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Адресов по сделкам нет. Объект можно завести во вкладке «Объекты».</div> : (
            <div className="flex flex-col gap-1">
              {objects.slice(0, 6).map(({ o, prof, st, s }) => (
                <button key={o.key} type="button" onClick={() => onOpenObject(o.key)}
                  className="flex min-h-11 items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--color-bg-hover)]">
                  <MapPin size={13} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[12.5px]" title={prof.idealAddress || o.address}>{prof.idealAddress ? shortAddress(prof.idealAddress) : o.label}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                      <StatusChip s={st} />
                      {s.groups[0] && <span>{shortGroup(s.groups[0].group)}{s.groups.length > 1 ? ` +${s.groups.length - 1}` : ''}</span>}
                      {s.ltv > 0 && <span className="tabular-nums">{fmtMoney(s.ltv)}</span>}
                    </span>
                  </span>
                </button>
              ))}
              {objects.length > 6 && <div className="px-1.5 text-[11.5px] text-[var(--color-text-muted)]">…и ещё {objects.length - 6} — во вкладке «Объекты»</div>}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
