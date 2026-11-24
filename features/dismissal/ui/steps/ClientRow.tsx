'use client';

import { useState } from 'react';
import { fmtMln, fmtNum, fmtRub, plural, type RepeatClient } from '../planMath';
import { RowCheck, TitleText, rowCls } from '../ItemRow';

// Строка-заказчик повторки (шаги 1–2): на ≥xl — CSS-grid колонками, ниже — карточка.

export const CLIENT_GRID = 'xl:grid xl:grid-cols-[28px_36px_minmax(0,1fr)_96px_56px_56px_220px] 2xl:grid-cols-[28px_40px_minmax(0,1fr)_120px_72px_64px_260px] xl:items-center xl:gap-3';

export function ClientHeader({ last }: { last: string }) {
  return (
    <div className={`sticky top-0 z-10 hidden border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-3 py-2 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)] ${CLIENT_GRID}`}>
      <span /><span>№</span><span>Заказчик</span><span className="text-right">LTV</span><span className="text-right">отгр.</span><span className="text-right">сделок</span><span>{last}</span>
    </div>
  );
}

export function ClientRow({ client, focused, selected, onToggle, onFocus, last }: {
  client: RepeatClient;
  focused: boolean;
  selected: boolean;
  onToggle: (shift: boolean) => void;
  onFocus: () => void;
  last: React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const deals = all ? client.items : client.items.slice(0, 2);
  const more = client.items.length - 2;
  return (
    <li data-row-key={client.key} onClick={onFocus}
      className={`flex min-h-14 flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-2.5 ${CLIENT_GRID} ${rowCls(focused, selected)}`}>
      <span className="pt-0.5 xl:pt-0"><RowCheck checked={selected} onToggle={onToggle} label={`Выбрать ${client.name}`} /></span>
      <span className="hidden text-xs tabular-nums text-[var(--color-text-muted)] xl:block">#{client.rank < 1e9 ? client.rank : '—'}</span>
      <div className="min-w-0 flex-1 basis-[calc(100%-40px)] xl:basis-auto">
        <div className="truncate text-sm font-medium text-[var(--color-text)]" title={client.name}>{client.name}</div>
        <div className="flex flex-col text-xs text-[var(--color-text-muted)]">
          {deals.map(it => (
            <span key={it.key} className="flex min-w-0 items-center gap-1.5">
              <TitleText item={it} className="max-w-[60%]" />
              <span className="truncate">{[it.info?.stageName, it.info?.amount ? fmtRub(it.info.amount) : null].filter(Boolean).join(' · ')}</span>
            </span>
          ))}
          {more > 0 && (
            <button type="button" onClick={e => { e.stopPropagation(); setAll(a => !a); }} className="tap-target self-start text-[var(--color-accent)] hover:underline">
              {all ? 'Свернуть' : `+${more} ${plural(more, ['сделка', 'сделки', 'сделок'])}`}
            </button>
          )}
        </div>
      </div>
      {/* числа: на ≥xl колонками, ниже — строкой */}
      <span className="hidden text-right text-sm tabular-nums xl:block">{fmtMln(client.ltv)}</span>
      <span className="hidden text-right text-sm tabular-nums xl:block">{client.shipments ? fmtNum(client.shipments) : '—'}</span>
      <span className="hidden text-right text-sm tabular-nums xl:block">{fmtNum(client.items.length)}</span>
      <div className="w-full pl-8 text-xs tabular-nums text-[var(--color-text-muted)] xl:hidden">
        #{client.rank < 1e9 ? client.rank : '—'} · LTV {fmtMln(client.ltv)} · {client.shipments ? `${fmtNum(client.shipments)} отгр.` : 'без отгрузок'} · {fmtNum(client.items.length)} {plural(client.items.length, ['сделка', 'сделки', 'сделок'])}
      </div>
      <div className="w-full min-w-0 pl-8 xl:w-auto xl:pl-0" onClick={e => e.stopPropagation()}>{last}</div>
    </li>
  );
}
