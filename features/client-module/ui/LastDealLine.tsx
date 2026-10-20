'use client';
// «Последняя сделка» на «Обзоре» (владелец 15.10): сразу видно, что было по
// самой свежей сделке — когда, какая группа, сумма, чем кончилось (у отказа —
// причина: стадия проигрыша «Больше ничего не нужно», «Дорого» …) и был ли звонок.
// Главный кейс владельца: после отгрузки автоматически создаётся сделка повторки,
// а менеджер закрывает её день в день, не позвонив, — это подсвечивается красным.
// Звонки клиенту по другой сделке, пока эта была открыта, тоже засчитываются.

import { Phone, PhoneOff } from 'lucide-react';
import { fmtMoney } from '@/features/customers/ui/shared';
import { type ClientModuleData, isOpenDeal } from '../engine/types';
import { Chip, fmtD, shortGroup } from './parts';
import { DealLink } from './dealLink';

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;

export function LastDealLine({ data }: { data: ClientModuleData }) {
  const d = data.deals[0];
  if (!d) return null;
  const c = data.lastDealCalls;
  const openMore = data.deals.slice(1).filter(isOpenDeal).length;
  const lifeDays = d.lostAt && d.createdAt ? (new Date(d.lostAt).getTime() - new Date(d.createdAt).getTime()) / 86_400_000 : null;
  const noCallsAtAll = !!c && c.total === 0 && c.clientCalls === 0;
  const flag = d.stage === 'lost' && noCallsAtAll
    ? (lifeDays !== null && lifeDays < 1 ? 'Закрыта в день создания без звонка' : `Закрыта без звонка${lifeDays !== null ? ` (за ${Math.round(lifeDays)} дн.)` : ''}`)
    : null;
  // Причины отказа значат разное (аудит 15.10): «больше ничего не нужно» —
  // стройка, возможно, кончилась; «не дозвонился» — просто перезвонить.
  const reason = d.stageName ?? '';
  const lostTone = /не дозвон/i.test(reason) ? 'warn' : /больше ничего|объектов больше нет/i.test(reason) ? 'muted' : 'neg';
  const lostHint = /не дозвон/i.test(reason) ? ' — перезвони' : /больше ничего|объектов больше нет/i.test(reason) ? ' — стройка закончена? уточни, нет ли новой' : '';
  const outcome =
    d.stage === 'lost' ? <Chip tone={lostTone}>Отказ{reason ? `: ${reason}` : ''}{d.lostAt ? ` · ${fmtD(d.lostAt)}` : ''}{lostHint}</Chip>
    : d.stage === 'shipped' ? <Chip tone="ok">Отгружена {fmtD(d.deliveredAt)}</Chip>
    : d.stage === 'sold' ? <Chip tone="accent">Продана {fmtD(d.soldAt)}{d.stageName ? ` · ${d.stageName}` : ''}</Chip>
    : <Chip tone="accent">В работе{d.stageName ? ` · ${d.stageName}` : ''}</Chip>;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 text-[12.5px]">
      <DealLink dealId={d.dealId} className="font-semibold hover:underline">
        Последняя сделка {fmtD(d.createdAt)}
      </DealLink>
      <span className="min-w-0 text-[var(--color-text-muted)]">
        {d.groups.length ? shortGroup(d.groups[0]) + (d.groups.length > 1 ? ` +${d.groups.length - 1}` : '') : 'без товаров'}
        {d.amount > 0 ? ` · ${fmtMoney(d.amount)}` : ''}
      </span>
      {/* Длинная причина отказа переносится, а не обрезается. */}
      <span className="min-w-0 max-w-full [&>span]:whitespace-normal">{outcome}</span>
      {flag && <Chip tone="neg">⚠ {flag}</Chip>}
      {openMore > 0 && <span className="text-[var(--color-text-muted)]">· ещё {openMore} в работе</span>}
      {c && !flag && (c.total === 0
        ? <span className="inline-flex items-center gap-1" style={c.clientCalls > 0 ? { color: 'var(--color-text-muted)' } : { color: 'var(--color-warning, #e8590c)' }}>
            <PhoneOff size={13} /> по сделке звонков нет{c.clientCalls > 0 ? `, но клиенту звонили ${c.clientCalls} ${plural(c.clientCalls, 'раз', 'раза', 'раз')}` : ''}
          </span>
        : <span className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
            <Phone size={13} />
            {c.total} {plural(c.total, 'звонок', 'звонка', 'звонков')}
            {c.talked > 0 ? `, ${c.talked} ${plural(c.talked, 'разговор', 'разговора', 'разговоров')} (${Math.max(1, Math.round(c.talkSec / 60))} мин)` : ', не дозвонились'}
            {c.lastAt ? ` · посл. ${fmtD(c.lastAt)}` : ''}
          </span>)}
    </div>
  );
}
