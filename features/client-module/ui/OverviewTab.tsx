'use client';
// Таб «Обзор» — первый экран для работы. Редизайн 14.10 по аудиту (Fable):
// три главные цифры + серая строка остального; баннер «сделки без объекта»;
// две колонки «Что везём и куда» (объекты в работе) / «Предложить клиенту»;
// товарные группы — топ-5. Блок клиента (тип, заметка) — компактной строкой в
// шапке виджета (ClientBar), а не радиокнопками на треть экрана.

import { useState } from 'react';
import { ArrowRight, MapPin, HelpCircle } from 'lucide-react';
import { fmtMoney } from '@/features/customers/ui/shared';
import { type ClientModuleData, computeStats, objectStatus, EMPTY_OBJECT_PROFILE } from '../engine/types';
import { Section, RecList, StatusDot, shortGroup, fmtD, useDismiss } from './parts';
import { TzMetrics } from './TzBlocks';
import { ClientHintCard, LegalLine } from './ClientHintCard';
import { LastDealLine } from './LastDealLine';

export function OverviewTab({ data, params, onOpenObject, onOpenDeals, onEditClient }: {
  data: ClientModuleData;
  params: Record<string, string>;
  onEditClient: () => void;
  onOpenObject: (key: string) => void;
  onOpenDeals: (filter: { object?: string }) => void;
}) {
  const [allGroups, setAllGroups] = useState(false);
  const dis = useDismiss(data, params);
  const stats = computeStats(data.deals);
  const lastDeal = [...data.deals].filter(d => d.deliveredAt).sort((a, b) => b.deliveredAt!.localeCompare(a.deliveredAt!))[0];
  const lastObj = lastDeal?.objectKey ? data.objects.find(o => o.key === lastDeal.objectKey)?.label : null;
  const noObj = data.deals.filter(d => !d.objectKey);
  const noObjSum = noObj.reduce((s, d) => s + d.amount, 0);
  const groupMax = stats.groups[0]?.sum ?? 0;
  const groups = allGroups ? stats.groups : stats.groups.slice(0, 5);

  const objects = data.objects.map(o => {
    const deals = data.deals.filter(d => d.objectKey === o.key);
    const prof = data.objectProfiles[o.key] ?? EMPTY_OBJECT_PROFILE;
    return { o, st: objectStatus(deals, { manual: o.manual, doneManual: prof.doneManual }, data.activeDays), s: computeStats(deals), ladder: data.recommendations.byObject[o.key] };
  });
  // Все объекты (правка 15.10: «объект есть, а на обзоре объектов нет» — показывали
  // только «в работе»): сначала в работе/новые, ниже завершённые — бледнее.
  const rank = { active: 0, new: 1, done: 2 } as const;
  const working = objects.filter(x => x.st !== 'done');
  const ordered = [...objects].sort((a, b) => rank[a.st] - rank[b.st] || (b.s.lastShippedAt ?? '').localeCompare(a.s.lastShippedAt ?? ''));
  const openN = stats.open;

  return (
    <div className="flex flex-col gap-3">
      {/* «Похоже, это …» — подсказка типа клиента (владелец 15.10) и ЕГРЮЛ. */}
      <ClientHintCard data={data} params={params} onEditClient={onEditClient} />
      <LegalLine data={data} />
      {/* Показатели а–ж ровно по ТЗ (аудит ТЗ↔реальность 14.10: при редизайне
          пропали «8 / 10», LTV, дата последней отгрузки и число объектов). */}
      <TzMetrics s={stats} objects={{ total: data.objects.length, active: working.filter(x => x.st === 'active').length }} />
      <LastDealLine data={data} />
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 px-0.5 text-[12px] text-[var(--color-text-muted)]">
        {openN > 0 ? <span>Сейчас в работе: <b className="text-[var(--color-text)]">{openN} {openN === 1 ? 'сделка' : openN < 5 ? 'сделки' : 'сделок'} на {fmtMoney(stats.openSum)}</b></span> : <span>Активных сделок нет</span>}
        {lastDeal && <span>· последняя отгрузка: {shortGroup(lastDeal.topGroup) || '—'}{lastObj ? ` → ${lastObj}` : ''}</span>}
      </div>

      {noObj.length > 0 && (
        <button type="button" onClick={() => onOpenDeals({ object: '__none' })}
          className="flex min-h-11 items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--color-warning,#e8590c)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-warning,#e8590c)_7%,transparent)] px-3 py-2 text-left text-[12.5px]">
          <MapPin size={15} className="shrink-0 text-[var(--color-warning,#e8590c)]" />
          <span className="min-w-0 flex-1"><b>{noObj.length} {noObj.length % 10 === 1 && noObj.length % 100 !== 11 ? 'сделка' : noObj.length % 10 >= 2 && noObj.length % 10 <= 4 && (noObj.length % 100 < 10 || noObj.length % 100 >= 20) ? 'сделки' : 'сделок'}{noObjSum > 0 ? ` на ${fmtMoney(noObjSum)}` : ''} без объекта</b> — адреса нет или он неточный. Разложить по объектам</span>
          <ArrowRight size={15} className="shrink-0" />
        </button>
      )}

      <div className="grid gap-3 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Section title={`Что везём и куда · ${objects.length}`} right={objects.length > 0 ? <span className="text-[11.5px] text-[var(--color-text-muted)]">в работе {working.length}</span> : undefined}>
          {objects.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Объектов нет — адресов в заявках и сделках не нашлось.</div> : (
            <div className="flex flex-col divide-y divide-[var(--color-border)]">
              {ordered.slice(0, 6).map(({ o, st, s, ladder }) => (
                <button key={o.key} type="button" onClick={() => onOpenObject(o.key)} className={`flex min-h-11 items-start gap-2 rounded-md px-1 py-2 text-left hover:bg-[var(--color-bg-hover)] ${st === 'done' ? 'opacity-60' : ''}`}>
                  <StatusDot s={st} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{o.label}</span>
                      <span className="shrink-0 text-[12.5px] font-semibold tabular-nums">{fmtMoney(s.ltv)}</span>
                    </span>
                    <span className="block truncate text-[12px] text-[var(--color-text-muted)]">
                      {ladder?.current ? shortGroup(ladder.current.group) : (s.groups[0] ? shortGroup(s.groups[0].group) : 'отгрузок нет')}
                      {s.groups.length > 1 ? ` +${s.groups.length - 1}` : ''}{s.lastShippedAt ? ` · ${fmtD(s.lastShippedAt)}` : ''}
                    </span>
                    {st === 'done' && <span className="mt-0.5 block text-[12px] text-[var(--color-text-muted)]">завершён{o.coarse ? ' · адрес до города' : ''}</span>}
                    {st !== 'done' && ladder?.next[0] && (
                      <span className="mt-0.5 block truncate text-[12px] text-[var(--color-warning,#e8590c)]">→ предложить: {shortGroup(ladder.next[0].group)}</span>
                    )}
                  </span>
                </button>
              ))}
              {ordered.length > 6 && <button type="button" onClick={() => onOpenObject('')} className="min-h-10 text-left text-[12px] text-[var(--color-accent)]">ещё {ordered.length - 6} — во вкладке «Объекты»</button>}
            </div>
          )}
        </Section>

        <Section title="Предложить клиенту" right={
          <span title="По цепочке стройки (майндкарта), истории переходов по базе и приоритетам «Что предложить». Подрядчикам — только общие этапы и частые переходы."
            className="cursor-help text-[var(--color-text-muted)]"><HelpCircle size={14} /></span>
        }>
          <RecList recs={data.recommendations.client} empty="Предложить по истории нечего." onDismiss={dis.onDismiss} onRestore={dis.onRestore} hidden={data.dismissed.client} />
          {dis.error && <div className="mt-1 text-[11.5px]" style={{ color: 'var(--color-negative, #e03131)' }}>{dis.error}</div>}
        </Section>
      </div>

      <Section title={`Товарные группы по отгрузкам · ${stats.groups.length}`}>
        {stats.groups.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Отгрузок с товарами нет</div> : (
          <div className="flex flex-col gap-1.5">
            {groups.map(g => (
              <div key={g.group} className="text-[12.5px]">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate" title={g.group}>{g.group}</span>
                  <span className="shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{g.deals} отгр. · {fmtD(g.lastAt)}</span>
                  <span className="w-[76px] shrink-0 text-right font-semibold tabular-nums">{fmtMoney(g.sum)}</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-hover)]">
                  <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${groupMax > 0 ? Math.max(2, (g.sum / groupMax) * 100) : 0}%` }} />
                </div>
              </div>
            ))}
            {stats.groups.length > 5 && (
              <button type="button" onClick={() => setAllGroups(v => !v)} className="mt-0.5 min-h-9 self-start text-[12px] text-[var(--color-accent)]">
                {allGroups ? 'свернуть' : `ещё ${stats.groups.length - 5}`}
              </button>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
