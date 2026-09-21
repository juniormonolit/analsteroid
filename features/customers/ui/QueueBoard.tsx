'use client';
// Доска заказчиков (правка владельца 17.09: «таблица нечитабельна — сделай
// карточки / мини-канбаны, объединённые в приоритеты»). Четыре колонки-очереди
// по окну повторной продажи (см. engine/customers.ts::assignQueue), в каждой —
// карточки с тем, что нужно считать за секунду: кто, что с окном, последняя
// отгрузка, покупки, сигнал, что предложить. Подробности — по клику в карточку.
// Данные — тот же /api/customers, по запросу на колонку с постраничным «ещё».
import { Fragment, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ExternalLink, PhoneOff, AlarmClock } from 'lucide-react';
import type { CustomerQueue, CustomerCategory } from '@/features/customers/engine/customers';
import { CONTACT_CHANNEL_LABELS } from '@/features/customers/engine/contactTypes';
import { QUEUE_META } from './QueueParts';
import {
  type ApiRow, fmtMoney, fmtDate, daysAgo, clientBitrixUrl, clientDisplayName,
  CATEGORY_LABELS, CATEGORY_STYLE, MODIFIER_LABELS,
} from './shared';

const TONE_COLOR: Record<CustomerQueue, string> = {
  window: 'var(--color-negative, #e03131)', missed: 'var(--color-warning, #d9840c)', faded: 'var(--color-accent)', rest: 'var(--color-text-muted)',
};

/** Одна строка про окно — общая для карточки заказчика и плитки доски. */
export function windowLine(r: ApiRow): { text: string; sub: string | null; color: string } {
  const q = r.queue;
  const color = TONE_COLOR[q.queue];
  if (!r.lastDeliveredAt) return { text: 'Отгрузок ещё не было', sub: null, color: TONE_COLOR.rest };
  if (r.hasOpenOrder) return { text: '📦 Заказ в работе — продано, ждёт отгрузки', sub: `предыдущая отгрузка ${fmtDate(r.lastDeliveredAt)}`, color: 'var(--color-positive, #2f9e44)' };
  const since = Math.floor(q.daysSinceDelivery ?? 0);
  const delivery = `${fmtDate(r.lastDeliveredAt)}${r.lastDeliveredGroup ? ` · ${r.lastDeliveredGroup}` : ''}${r.lastDeliveredAmount ? ` · ${fmtMoney(r.lastDeliveredAmount)}` : ''}`;
  if (q.queue === 'window') {
    const left = q.daysLeft ?? 0;
    return { text: left < 1 ? '🔥 Окно закрывается сегодня' : `🔥 ${Math.ceil(left)} дн. до закрытия окна`, sub: `отгрузка ${delivery}`, color };
  }
  if (q.queue === 'missed') return { text: `Окно упущено · ${since} дн. без звонка`, sub: `отгрузка ${delivery}`, color };
  if (q.queue === 'faded') return { text: `Тихо ${since} дн. · его цикл ${Math.round(r.cycleDays)} дн.`, sub: `последняя отгрузка ${delivery}`, color };
  if (q.contactedAfter === 'call') return { text: `Звонок ${daysAgo(r.lastGoodCallAt)} после отгрузки`, sub: `отгрузка ${delivery}`, color };
  if (q.contactedAfter === 'manual' && r.lastContact) return { text: `Связался ${daysAgo(r.lastContact.contactedAt)} · ${CONTACT_CHANNEL_LABELS[r.lastContact.channel]}`, sub: `отгрузка ${delivery}`, color };
  return { text: `Отгрузка ${since} дн. назад`, sub: delivery, color };
}

function Chip({ children, title, color, bg }: { children: React.ReactNode; title?: string; color?: string; bg?: string }) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-px text-[10.5px] font-semibold"
      style={{ color: color ?? 'var(--color-text-muted)', backgroundColor: bg ?? 'var(--color-bg-hover)' }}>{children}</span>
  );
}

export function CustomerTile({ r, onOpen, actions }: { r: ApiRow; onOpen: () => void; actions: React.ReactNode }) {
  const w = windowLine(r);
  const cat = (r.category ?? 'none') as CustomerCategory;
  const st = CATEGORY_STYLE[cat];
  const silent = r.activeDeals.reduce((mx, d) => Math.max(mx, d.daysSilent), 0);
  const rec = r.recommend?.items?.[0] ?? null;
  const neg = 'var(--color-negative, #e03131)';
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 shadow-sm"
      style={{ borderLeft: `3px solid ${r.queue.queue === 'rest' ? 'var(--color-border)' : w.color}` }}>
      {/* Имя + чипы */}
      <div className="flex items-start gap-1.5 min-w-0">
        <button type="button" onClick={onOpen} title="Открыть карточку заказчика"
          className="min-w-0 flex-1 text-left text-[13.5px] font-bold leading-tight text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline truncate">
          {clientDisplayName(r)}
        </button>
        <a href={clientBitrixUrl(r)} target="_blank" rel="noreferrer" title="Открыть в Битриксе" className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><ExternalLink size={13} /></a>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Chip>{r.clientType === 'contact' ? 'физ' : 'юр'}</Chip>
        {cat !== 'none' && <Chip color={st.color} bg={st.bg} title="Категория заказчика">{cat === 'key' && '🔑 '}{CATEGORY_LABELS[cat]}</Chip>}
        {(r.modifiers ?? []).map(m => <span key={m} className="text-[12px]" title={`${MODIFIER_LABELS[m].label} — ${MODIFIER_LABELS[m].hint}`}>{MODIFIER_LABELS[m].icon}</span>)}
        {r.pendingExclusion && <Chip title={`Запрос на исключение: «${r.pendingExclusion.reason}»`}>⏳ ждёт РОПа</Chip>}
        {r.snoozedActive && r.mark && <Chip title={`Отложен до ${fmtDate(r.mark.snoozeUntil)}`}>⏸ до {fmtDate(r.mark.snoozeUntil)}</Chip>}
        {r.managerName && <Chip title="Менеджер заказчика" color="var(--color-accent)" bg="var(--color-accent-soft, #e7f1fb)">{r.managerName}</Chip>}
        {r.prevManagerNames.length > 0 && <Chip title={`Ранее вёл(а): ${r.prevManagerNames.join(', ')}`}>ранее: {r.prevManagerNames[0]}{r.prevManagerNames.length > 1 ? ` +${r.prevManagerNames.length - 1}` : ''}</Chip>}
      </div>
      {/* Окно */}
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold leading-tight" style={{ color: w.color }}>{w.text}</div>
        {w.sub && <div className="text-[11px] text-[var(--color-text-muted)] truncate" title={w.sub}>{w.sub}</div>}
        {r.autoRepeatLostNoCall && r.queue.queue !== 'rest' && (
          <div className="text-[11px] font-semibold" style={{ color: neg }} title="Авто-сделка повторки после этой отгрузки закрыта в отказ без успешного звонка">⚠ сделку закрыли без звонка</div>
        )}
      </div>
      {/* Цифры */}
      <div className="grid grid-cols-3 gap-1.5 text-[11.5px]">
        <div className="min-w-0"><div className="text-[10px] text-[var(--color-text-muted)]">Покупок</div><div className="font-semibold tabular-nums">{r.dealsSold}<span className="text-[var(--color-text-muted)] font-normal">/{r.dealsTotal}</span></div></div>
        <div className="min-w-0"><div className="text-[10px] text-[var(--color-text-muted)]">Куплено на</div><div className="font-semibold tabular-nums whitespace-nowrap">{r.sumSold > 0 ? fmtMoney(r.sumSold) : '—'}</div></div>
        <div className="min-w-0"><div className="text-[10px] text-[var(--color-text-muted)]">Активных</div>
          <div className="font-semibold tabular-nums whitespace-nowrap">
            {r.activeCount || '—'}
            {silent > 7 && <span className="ml-1 font-semibold" style={{ color: neg }} title="Активная сделка без звонка дольше недели"><PhoneOff size={10} className="inline -mt-px" /> {Math.floor(silent)} дн.</span>}
          </div>
        </div>
      </div>
      {/* Предложить */}
      {rec && (
        <div className="text-[11.5px] truncate" title={r.recommend!.items.slice(0, 3).map(i => `${i.group} ${i.pct}%`).join(' · ')}>
          <span className="text-[var(--color-text-muted)]">Предложить: </span>
          <span className="font-semibold text-[var(--color-accent)]">{rec.pct}%</span> {rec.group}
          {r.recommend!.items.length > 1 && <span className="text-[var(--color-text-muted)]"> +{r.recommend!.items.length - 1}</span>}
          {/* Награда за допродажу (кросс-селл бейдж + ебаллы) скрыта 21.09 по
              правке владельца: геймификация временно убрана с глаз. Данные
              приходят (rec.badge) — вернуть можно одной строкой. */}
        </div>
      )}
      {r.signals.includes('overdue_repeat') && r.queue.queue === 'rest' && (
        <div className="text-[11px] font-semibold" style={{ color: 'var(--color-warning, #d9840c)' }}><AlarmClock size={10} className="inline -mt-px" /> пора позвонить — цикл вышел</div>
      )}
      {/* Действия */}
      <div className="flex items-center justify-between gap-1 pt-1 border-t border-[var(--color-border)]">
        <span className="text-[10.5px] text-[var(--color-text-muted)] truncate" title={r.lastCallAt ? `Последний звонок ${fmtDate(r.lastCallAt)}` : 'Звонков не было'}>звонок {daysAgo(r.lastCallAt)}</span>
        <div className="shrink-0">{actions}</div>
      </div>
    </div>
  );
}

// ── Колонка очереди с постраничным «ещё» ────────────────────────────────────
interface PageResponse { total: number; rows: ApiRow[]; page: number; pageSize: number; counts: { queues?: Record<string, number> } }
const PAGE = 24;

function useQueuePages(managerId: string, isSelf: boolean, filter: string, search: string, category: string, sort: string, team?: boolean, mgr?: string, dept?: string) {
  return useInfiniteQuery<PageResponse>({
    queryKey: ['customers', team ? `team:${managerId}:${dept ?? ''}:${mgr ?? 'all'}` : isSelf ? 'me' : managerId, 'board', filter, search, category, sort],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ filter, page: String(pageParam), pageSize: String(PAGE) });
      if (team) { qs.set('team', '1'); qs.set('for', managerId); if (mgr) qs.set('mgr', mgr); if (dept) qs.set('dept', dept); } else if (!isSelf) qs.set('bitrixId', managerId);
      if (search) qs.set('search', search);
      if (category && category !== 'all') qs.set('category', category);
      if (sort) { const [k, d] = sort.split(':'); qs.set('sort', k); qs.set('dir', d); }
      const res = await fetch(`/api/customers?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    getNextPageParam: last => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    staleTime: 60_000, refetchOnWindowFocus: false,
  });
}

function QueueColumn({ queue, managerId, isSelf, search, category, sort, onOpen, renderActions, single, team, mgr, dept }: {
  queue: CustomerQueue | 'archive'; managerId: string; isSelf: boolean; search: string; category: string; sort: string;
  onOpen: (r: ApiRow) => void; renderActions: (r: ApiRow) => React.ReactNode; single: boolean; filterKey?: string; team?: boolean; mgr?: string; dept?: string;
}) {
  const q = useQueuePages(managerId, isSelf, queue, search, category, sort, team, mgr, dept);
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap(p => p.rows), [q.data]);
  const total = q.data?.pages[0]?.total ?? null;
  const meta = queue === 'archive' ? null : QUEUE_META[queue];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {meta && (
        <div className="flex items-baseline gap-2 px-0.5" title={meta.hint}>
          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: TONE_COLOR[queue as CustomerQueue] }}>{meta.label}</span>
          {total !== null && <span className="text-[11px] font-semibold tabular-nums text-[var(--color-text-muted)]">{total}</span>}
        </div>
      )}
      {q.isLoading ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">Считаем…</div>
      ) : q.isError ? (
        <div className="text-xs text-[var(--color-negative)]">Не удалось загрузить.</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
          {queue === 'window' ? 'Все окна закрыты звонком 👍' : 'Пусто'}
        </div>
      ) : (
        <div className={single ? 'grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2' : 'flex flex-col gap-2'}>
          {rows.map(r => <CustomerTile key={r.clientKey} r={r} onOpen={() => onOpen(r)} actions={renderActions(r)} />)}
        </div>
      )}
      {q.hasNextPage && (
        <button type="button" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}
          className="min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
          {q.isFetchingNextPage ? 'Загружаем…' : `Ещё ${Math.min(PAGE, (total ?? 0) - rows.length)} из ${(total ?? 0) - rows.length}`}
        </button>
      )}
    </div>
  );
}

/** Доска: filter='all' — четыре очереди колонками; иначе одна очередь/вкладка сеткой карточек. */
export function QueueBoard({ managerId, isSelf, filter, search, category, sort, onOpen, renderActions, team, mgr, dept }: {
  managerId: string; isSelf: boolean; filter: string; search: string; category: string; sort: string;
  onOpen: (r: ApiRow) => void; renderActions: (r: ApiRow) => React.ReactNode; team?: boolean; mgr?: string; dept?: string;
}) {
  if (filter === 'all') {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 items-start">
        {(['window', 'missed', 'faded', 'rest'] as CustomerQueue[]).map(qk => (
          <Fragment key={qk}>
            <QueueColumn queue={qk} managerId={managerId} isSelf={isSelf} search={search} category={category} sort={sort} onOpen={onOpen} renderActions={renderActions} single={false} team={team} mgr={mgr} dept={dept} />
          </Fragment>
        ))}
      </div>
    );
  }
  const asQueue = (['window', 'missed', 'faded', 'rest'] as string[]).includes(filter) ? (filter as CustomerQueue) : 'archive';
  return <QueueColumnByFilter filter={filter} queue={asQueue} managerId={managerId} isSelf={isSelf} search={search} category={category} sort={sort} onOpen={onOpen} renderActions={renderActions} team={team} mgr={mgr} dept={dept} />;
}

function QueueColumnByFilter(p: { filter: string; queue: CustomerQueue | 'archive'; managerId: string; isSelf: boolean; search: string; category: string; sort: string; onOpen: (r: ApiRow) => void; renderActions: (r: ApiRow) => React.ReactNode; team?: boolean; mgr?: string; dept?: string }) {
  const q = useQueuePages(p.managerId, p.isSelf, p.filter, p.search, p.category, p.sort, p.team, p.mgr, p.dept);
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap(x => x.rows), [q.data]);
  const total = q.data?.pages[0]?.total ?? null;
  return (
    <div className="flex flex-col gap-2">
      {q.isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Считаем заказчиков… (первое открытие может занять до минуты)</div>
        : q.isError ? <div className="text-sm text-[var(--color-negative)]">Не удалось загрузить список заказчиков.</div>
        : rows.length === 0 ? <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">Пусто — либо фильтры узкие, либо у этой роли нет своих клиентов.</div>
        : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2">
            {rows.map(r => <CustomerTile key={r.clientKey} r={r} onOpen={() => p.onOpen(r)} actions={p.renderActions(r)} />)}
          </div>
        )}
      {q.hasNextPage && (
        <button type="button" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}
          className="self-start min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
          {q.isFetchingNextPage ? 'Загружаем…' : `Ещё ${Math.min(PAGE, (total ?? 0) - rows.length)} из ${(total ?? 0) - rows.length}`}
        </button>
      )}
    </div>
  );
}
