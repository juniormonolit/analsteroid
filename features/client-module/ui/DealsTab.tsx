'use client';
// Таб «Сделки» карточки клиента (правка владельца 13.10): все сделки таблицей
// без лишнего — дата создания, название (ссылка), товарная группа с наибольшей
// суммой, сумма, объект, стадия; фильтры по объекту, товарной группе и стадии;
// строка раскрывается в товары. Там же — перепривязка сделки к объекту, если
// автоматическая по адресу ошиблась.

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtMoney, dealBitrixUrl } from '@/features/customers/ui/shared';
import { type ClientModuleData, type ModuleDeal, type DealStage, DEAL_STAGE_LABEL, dealSortDate } from '../engine/types';
import { StageChip, selectCls, useSave, shortGroup, fmtD, dealTitle } from './parts';
import { shortAddress } from '../engine/objectClusters';

const STAGES: DealStage[] = ['shipped', 'sold', 'active', 'lost'];

function objectLabel(data: ClientModuleData, key: string | null): string {
  if (!key) return '—';
  return data.objects.find(x => x.key === key)?.label ?? '—';
}

/** Ячейка «Объект»: населённый пункт; нет объекта — неточный адрес серым или «—». */
function ObjectCell({ d, data, inline }: { d: ModuleDeal; data: ClientModuleData; inline?: boolean }) {
  const cls = inline ? '' : 'line-clamp-2';
  if (d.objectKey) return <span className={cls} title={data.objects.find(o => o.key === d.objectKey)?.address}>{objectLabel(data, d.objectKey)}</span>;
  if (d.looseAddress) return <span className={`${cls} text-[var(--color-text-muted)]`} title={`Адрес неточный — объектом не считается: ${d.looseAddress}`}>{shortAddress(d.looseAddress)} · неточный</span>;
  return <span className="text-[var(--color-text-muted)]">без объекта</span>;
}

function DealRowExpanded({ d, data, params }: { d: ModuleDeal; data: ClientModuleData; params: Record<string, string> }) {
  const { save, saving, error } = useSave(params);
  const total = d.products.reduce((s, p) => s + p.sum, 0);
  return (
    <div className="bg-[var(--color-bg)] px-3 py-2">
      {d.products.length === 0 ? (
        <div className="text-[12px] text-[var(--color-text-muted)]">В сделке нет товарных позиций</div>
      ) : (
        <div className="flex flex-col divide-y divide-[var(--color-border)] text-[12px]">
          {d.products.map((p, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-x-3 py-1">
              <span className="min-w-0 flex-1 basis-[220px] break-words">{p.name}</span>
              <span className="tabular-nums text-[var(--color-text-muted)]">{p.quantity.toLocaleString('ru-RU')} × {fmtMoney(p.price)}{p.group ? ` · ${p.group}` : ''}</span>
              <span className="ml-auto font-medium tabular-nums">{fmtMoney(p.sum)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-[var(--color-text-muted)]">
        {d.stageName && <span>Стадия в Битриксе: <b className="text-[var(--color-text)]">{d.stageName}</b></span>}
        {d.managerName && <span>· {d.managerName}</span>}
        {d.deliveredAt && <span>· отгружена {fmtD(d.deliveredAt)}</span>}
        {d.products.length > 0 && <span className="ml-auto">Итого по товарам: <b className="tabular-nums text-[var(--color-text)]">{fmtMoney(total)}</b></span>}
      </div>
      {data.objects.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-[var(--color-text-muted)]">Объект сделки{d.objectManual ? ' (указан вручную)' : ' (по адресу)'}:</span>
          <select className={`${selectCls} w-full sm:w-auto sm:max-w-[360px]`} disabled={saving || !data.v2Available}
            value={d.objectManual ? d.objectKey ?? '' : ''}
            onChange={e => void save({ deal: { dealId: d.dealId, objectKey: e.target.value } })}>
            <option value="">{`Автоматически — ${objectLabel(data, d.objectManual ? null : d.objectKey)}`}</option>
            {data.objects.map(o => <option key={o.key} value={o.key}>{objectLabel(data, o.key)}</option>)}
          </select>
          {!data.v2Available && <span className="text-[var(--color-text-muted)]">перепривязка — после миграции 006</span>}
          {error && <span style={{ color: 'var(--color-negative, #e03131)' }}>{error}</span>}
        </div>
      )}
    </div>
  );
}

export function DealsTab({ data, params, initialObject }: { data: ClientModuleData; params: Record<string, string>; initialObject?: string | null }) {
  const [obj, setObj] = useState<string>(initialObject ?? '');
  const [group, setGroup] = useState('');
  const [stages, setStages] = useState<Set<DealStage>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());

  const groups = useMemo(() => [...new Set(data.deals.flatMap(d => d.groups))].sort((a, b) => a.localeCompare(b, 'ru')), [data.deals]);
  const rows = useMemo(() => data.deals
    .filter(d => !obj || (obj === '__none' ? !d.objectKey : d.objectKey === obj))
    .filter(d => !group || d.groups.includes(group))
    .filter(d => stages.size === 0 || stages.has(d.stage))
    .sort((a, b) => dealSortDate(b).localeCompare(dealSortDate(a))), [data.deals, obj, group, stages]);
  const sum = rows.reduce((s, d) => s + d.amount, 0);
  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  const noObj = data.deals.filter(d => !d.objectKey).length;
  const stageCount = (st: DealStage) => data.deals.filter(d => d.stage === st && (!obj || (obj === '__none' ? !d.objectKey : d.objectKey === obj))).length;
  const chip = (on: boolean) => `min-h-9 rounded-lg border px-2.5 text-[12px] ${on ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${selectCls} w-full sm:w-auto sm:max-w-[220px]`} value={obj} onChange={e => setObj(e.target.value)} aria-label="Объект">
          <option value="">Все объекты</option>
          {data.objects.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          <option value="__none">Без объекта</option>
        </select>
        <select className={`${selectCls} w-full sm:w-auto sm:max-w-[220px]`} value={group} onChange={e => setGroup(e.target.value)} aria-label="Товарная группа">
          <option value="">Все товарные группы</option>
          {groups.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <div className="flex flex-wrap gap-1">
          {STAGES.map(st => (
            <button key={st} type="button" onClick={() => setStages(toggle(stages, st))} aria-pressed={stages.has(st)} className={chip(stages.has(st))}>
              {DEAL_STAGE_LABEL[st]} <span className="tabular-nums opacity-70">{stageCount(st)}</span>
            </button>
          ))}
          {noObj > 0 && (
            <button type="button" onClick={() => setObj(obj === '__none' ? '' : '__none')} aria-pressed={obj === '__none'} className={chip(obj === '__none')}>
              Без объекта <span className="tabular-nums opacity-70">{noObj}</span>
            </button>
          )}
        </div>
        <span className="ml-auto text-[12px] text-[var(--color-text-muted)]">{rows.length} на <b className="tabular-nums text-[var(--color-text)]">{fmtMoney(sum)}</b></span>
      </div>

      {rows.length === 0 && <div className="rounded-xl border border-[var(--color-border)] px-3 py-6 text-center text-[13px] text-[var(--color-text-muted)]">Сделок по фильтру нет</div>}

      {/* Телефон/узкий фрейм — карточки в две строки (аудит 14.10: 6 колонок не помещаются). */}
      {rows.length > 0 && (
        <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] md:hidden">
          {rows.map(d => {
            const isOpen = open.has(d.dealId);
            return (
              <div key={d.dealId}>
                <button type="button" onClick={() => setOpen(toggle(open, d.dealId))} aria-expanded={isOpen} className="flex w-full items-start gap-2 px-3 py-2 text-left">
                  <span className="mt-0.5 shrink-0 text-[var(--color-text-muted)]">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2 text-[13px]">
                      <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtD(d.createdAt)}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{dealTitle(d)}</span>
                      <span className="shrink-0 font-semibold tabular-nums">{d.amount > 0 ? fmtMoney(d.amount) : '—'}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
                      <span className="min-w-0 flex-1 truncate">{d.topGroup ? shortGroup(d.topGroup) : '—'} · <ObjectCell d={d} data={data} inline /></span>
                      <StageChip s={d.stage} />
                    </span>
                  </span>
                </button>
                {isOpen && (
                  <>
                    <div className="px-3 pb-1"><a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="text-[12px] text-[var(--color-accent)] hover:underline">Открыть в Битриксе</a></div>
                    <DealRowExpanded d={d} data={data} params={params} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <div className="scroll-x hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] md:block">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="w-7 px-1 py-2" />
                <th className="px-2 py-2 font-semibold">Создана</th>
                <th className="px-2 py-2 font-semibold">Название</th>
                <th className="px-2 py-2 font-semibold">Группа</th>
                <th className="px-2 py-2 text-right font-semibold">Сумма</th>
                <th className="px-2 py-2 font-semibold">Объект</th>
                <th className="px-2 py-2 font-semibold">Стадия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(d => {
                const isOpen = open.has(d.dealId);
                return (
                  <Fragment key={d.dealId}>
                    <tr onClick={() => setOpen(toggle(open, d.dealId))} className={`cursor-pointer border-b border-[var(--color-border)] ${isOpen ? 'bg-[var(--color-bg-hover)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
                      <td className="px-1 py-1.5 align-top text-[var(--color-text-muted)]">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 align-top tabular-nums text-[var(--color-text-muted)]">{fmtD(d.createdAt)}</td>
                      <td className="max-w-[240px] px-2 py-1.5 align-top">
                        <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                          className="line-clamp-2 text-[var(--color-accent)] hover:underline" title="Открыть сделку в Битриксе">{dealTitle(d)}</a>
                      </td>
                      <td className="max-w-[170px] px-2 py-1.5 align-top" title={d.groups.join(', ')}>
                        <span className="line-clamp-2">{d.topGroup ? shortGroup(d.topGroup) : <span className="text-[var(--color-text-muted)]">—</span>}{d.groups.length > 1 && <span className="text-[11px] text-[var(--color-text-muted)]"> +{d.groups.length - 1}</span>}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right align-top font-semibold tabular-nums">{d.amount > 0 ? fmtMoney(d.amount) : '—'}</td>
                      <td className="max-w-[170px] px-2 py-1.5 align-top text-[12px]"><ObjectCell d={d} data={data} /></td>
                      <td className="whitespace-nowrap px-2 py-1.5 align-top"><StageChip s={d.stage} /></td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-[var(--color-border)]">
                        <td colSpan={7} className="p-0"><DealRowExpanded d={d} data={data} params={params} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
