'use client';
import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronRight, Users } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { DealCard } from './DealCard';
import type { MatrixTransitionsResult, TransitionChain, TransitionDealBrief, TransitionNextGroup } from '@/features/reports/engine/productMatrix';

// Дрилл ячейки «Матрицы переходов» (задача владельца 10.09): «хочу видеть список
// всех менеджеров и явно понимать, кто лучше продаёт кровлю после газобетона, и
// дальше провалиться в эти сделки и увидеть цепочку».
//
// Слева — менеджеры ЗАКРЫВАЮЩЕЙ сделки: сколько связок и какая доля от ИХ
// СОБСТВЕННЫХ повторных покупок после исходной категории (иначе рейтинг просто
// повторял бы размер клиентской базы). Справа — два таба (правка владельца 11.09):
//   * «A → B» — цепочки самой ячейки: предыдущая покупка → следующая;
//   * «A → остальное» — чем ВООБЩЕ продолжали после A, агрегатами по товарной
//     группе следующей покупки (сама ячейка в списке подсвечена).
// Клик по сделке открывает карточку поверх (как в дрилл-дауне отчёта).
//
// Формат — выезжающая справа панель на ~80 % ширины (правка владельца 10.09:
// «вместо попапа слайдер дрилл-дауна как в обычном отчёте, поверх него уже
// сделка»), а не модал: карточка сделки (z-[70]) ложится поверх панели (z-[61]),
// и обе живут во весь экран, без вложенных окон.
//
// Высоты (правка владельца 11.09: «окно просмотра цепочек не до низа экрана»):
// колонки тянутся до низа панели через flex + min-h-0, а не через прежние
// max-h-[52vh]/[62vh] — фиксированные vh обрезали списки на середине экрана и
// не зависели от реальной высоты шапки. На узких экранах (< lg) колонки идут
// стопкой и скроллится всё тело панели, на lg+ — каждая колонка сама.

const fmtMoney = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
const fmtMln = (v: number) => `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
const fmtDate = (iso: string) => (iso ? format(new Date(iso), 'd MMM yy', { locale: ru }) : '—');
const pctStr = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)} %`;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] truncate">{label}</div>
      <div className="text-sm font-semibold tabular-nums text-[var(--color-text)] truncate">{value}</div>
      {hint && <div className="text-[10px] text-[var(--color-text-muted)] truncate">{hint}</div>}
    </div>
  );
}

function DealSide({ deal, highlight, onOpen }: { deal: TransitionDealBrief; highlight: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex-1 min-w-0 text-left rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 hover:border-[var(--color-accent)] transition-colors"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-mono text-[var(--color-accent)] shrink-0">#{deal.dealId}</span>
        <span className="text-[11px] text-[var(--color-text-muted)] shrink-0 tabular-nums">{fmtDate(deal.at)}</span>
        <span className="ml-auto text-xs tabular-nums text-[var(--color-text)] shrink-0">{fmtMoney(deal.amount)}</span>
      </div>
      <div className="mt-0.5 text-xs text-[var(--color-text)] break-words line-clamp-2">{deal.name ?? '—'}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {deal.cats.map(c => (
          <span
            key={c}
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              c === highlight
                ? 'bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-[var(--color-accent)] font-medium'
                : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'
            }`}
          >
            {c}
          </span>
        ))}
      </div>
    </button>
  );
}

function ChainRow({ chain, from, to, onOpenDeal }: {
  chain: TransitionChain; from: string; to: string; onOpenDeal: (id: number) => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-2">
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-[var(--color-text-muted)]">
        <Users size={11} className="shrink-0" />
        <span className="truncate">{chain.managerName ?? `Менеджер ${chain.managerId ?? '—'}`}</span>
        <span className="ml-auto shrink-0 tabular-nums">через {chain.days} дн.</span>
      </div>
      {/* Две колонки: было → стало. На телефоне — стопкой, стрелка поворачивается. */}
      <div className="flex flex-col sm:flex-row items-stretch gap-2">
        <DealSide deal={chain.prev} highlight={from} onOpen={() => onOpenDeal(chain.prev.dealId)} />
        <div className="flex items-center justify-center shrink-0 text-[var(--color-accent)]">
          <ArrowRight size={16} className="rotate-90 sm:rotate-0" />
        </div>
        <DealSide deal={chain.next} highlight={to} onOpen={() => onOpenDeal(chain.next.dealId)} />
      </div>
    </div>
  );
}

/** Цепочки одной группы внутри таба «→ остальное» (правка владельца 11.09:
 *  «сгруппированные связки не раскрываются, а хотелось бы их видеть»).
 *  Тот же эндпоинт, что и у ячейки, только `to` = раскрытая группа — поэтому
 *  выбор менеджера слева и фильтры отчёта работают здесь автоматически. */
function GroupChains({ from, cat, filters, drillManagerId, onOpenDeal }: {
  from: string; cat: string; filters: Record<string, unknown>;
  drillManagerId: string | null; onOpenDeal: (id: number) => void;
}) {
  const body = useMemo(() => ({ ...filters, from, to: cat, drillManagerId }), [filters, from, cat, drillManagerId]);
  const { data, isLoading, error } = useQuery<MatrixTransitionsResult>({
    queryKey: ['matrix-transitions', body],
    queryFn: async () => {
      const res = await fetch('/api/reports/product-matrix/transitions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return <div className="space-y-1.5 py-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 bg-[var(--color-border)] rounded animate-pulse" />)}</div>;
  }
  if (error) {
    return <div className="py-3 text-sm text-[var(--color-negative,#d33)]">{error instanceof Error ? error.message : String(error)}</div>;
  }
  return (
    <div className="flex flex-col gap-2 py-2">
      {(data?.chains ?? []).map(c => (
        <ChainRow key={`${c.prev.dealId}-${c.next.dealId}`} chain={c} from={from} to={cat} onOpenDeal={onOpenDeal} />
      ))}
      {(data?.chains ?? []).length === 0 && (
        <div className="py-3 text-center text-sm text-[var(--color-text-muted)]">Цепочек нет</div>
      )}
      {data?.truncated && (
        <div className="text-[11px] text-[var(--color-text-muted)]">показаны последние 300 из {data.total}</div>
      )}
    </div>
  );
}

/** Таб «A → остальное»: агрегаты по товарной группе следующей покупки; строка
 *  раскрывается в цепочки этой группы. */
function NextGroupsTable({ groups, base, to, from, filters, drillManagerId, onOpenDeal }: {
  groups: TransitionNextGroup[]; base: number; to: string; from: string;
  filters: Record<string, unknown>; drillManagerId: string | null; onOpenDeal: (id: number) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const maxN = Math.max(1, ...groups.map(g => g.n));
  if (groups.length === 0) {
    return <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Повторных покупок после «{from}» в этом срезе нет</div>;
  }
  const toggle = (cat: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });
  return (
    <div className="scroll-x">
      <table className="w-full text-sm min-w-[560px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
            <th className="text-left font-medium py-1.5 pr-2">Группа следующей покупки</th>
            <th className="text-right font-medium py-1.5 px-2 whitespace-nowrap">Случаев</th>
            <th className="text-right font-medium py-1.5 px-2 whitespace-nowrap">Доля</th>
            <th className="text-right font-medium py-1.5 px-2 whitespace-nowrap">Заказчиков</th>
            <th className="text-right font-medium py-1.5 px-2 whitespace-nowrap">Сумма</th>
            <th className="text-right font-medium py-1.5 pl-2 whitespace-nowrap">Медиана</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(g => {
            const share = base > 0 ? (g.n / base) * 100 : 0;
            const current = g.cat === to;
            const expanded = open.has(g.cat);
            return (
              <Fragment key={g.cat}>
                <tr
                  onClick={() => toggle(g.cat)}
                  className={`border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors ${
                    current ? 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : ''
                  }`}
                >
                  <td className="py-1.5 pr-2 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ChevronRight size={13} className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${expanded ? 'rotate-90' : ''}`} />
                      <span className={`truncate ${current ? 'font-semibold text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>
                        {g.cat}
                      </span>
                      {current && <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-accent)]">ячейка</span>}
                    </div>
                    {/* Полоска — вклад группы относительно самой массовой: видно, чем
                        продолжают чаще всего, без чтения цифр. */}
                    <div className="mt-1 h-1 rounded bg-[var(--color-bg-hover)] overflow-hidden">
                      <div className="h-full bg-[var(--color-accent)]" style={{ width: `${(g.n / maxN) * 100}%` }} />
                    </div>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-[var(--color-text)]">{g.n}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-[var(--color-text-muted)]">{pctStr(share)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-[var(--color-text-muted)]">{g.clients}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-[var(--color-text)]">{fmtMln(g.sumNext)}</td>
                  <td className="py-1.5 pl-2 text-right tabular-nums text-[var(--color-text-muted)]">
                    {g.medianDays === null ? '—' : `${g.medianDays} дн.`}
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-[var(--color-border)]">
                    <td colSpan={6} className="pl-5 pr-2">
                      <GroupChains
                        from={from} cat={g.cat} filters={filters}
                        drillManagerId={drillManagerId} onOpenDeal={onOpenDeal}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TransitionDrillModal({ from, to, filters, onClose }: {
  from: string;
  to: string;
  /** Тело запроса матрицы: период, отделы, менеджеры, пилюли, mode. */
  filters: Record<string, unknown>;
  onClose: () => void;
}) {
  const [drillManagerId, setDrillManagerId] = useState<string | null>(null);
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  const [tab, setTab] = useState<'chains' | 'groups'>('chains');

  const body = useMemo(() => ({ ...filters, from, to, drillManagerId }), [filters, from, to, drillManagerId]);
  const { data, isLoading, error } = useQuery<MatrixTransitionsResult>({
    queryKey: ['matrix-transitions', body],
    queryFn: async () => {
      const res = await fetch('/api/reports/product-matrix/transitions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const pct = data && data.afterFrom > 0 ? (data.total / data.afterFrom) * 100 : 0;
  const maxN = Math.max(1, ...(data?.managers ?? []).map(m => m.n));
  const selected = data?.managers.find(m => m.managerId === drillManagerId) ?? null;
  const hits = data?.hitsAgg;
  const avgCheck = hits && hits.n > 0 ? hits.sumNext / hits.n : 0;
  // Доля денег: сколько из всех повторных покупок после A принесла именно эта связка.
  const moneyShare = data && data.afterFromAgg.sumNext > 0
    ? ((hits?.sumNext ?? 0) / data.afterFromAgg.sumNext) * 100 : 0;

  const { closing, requestClose } = useSlideClose(onClose);

  return (
    <div className="fixed inset-0 z-[60]">
      <SlideBackdrop closing={closing} onClick={requestClose} className="z-[60]" />
      <div className={`fixed inset-y-0 right-0 z-[61] w-full sm:w-[80vw] sm:min-w-[720px] sm:max-w-[1600px] bg-[var(--color-bg)] shadow-2xl border-l border-[var(--color-border)] flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />
        <div className="shrink-0 px-3 sm:px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <h2 className="flex flex-wrap items-baseline gap-x-2 min-w-0 text-base font-semibold text-[var(--color-text)]">
            <span className="truncate">{from}</span>
            <ArrowRight size={14} className="shrink-0 text-[var(--color-accent)]" />
            <span className="truncate">{to}</span>
          </h2>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
            {isLoading ? 'Считаем…' : error ? '' : (
              <>
                <b className="text-[var(--color-text)] tabular-nums">{data?.total ?? 0}</b> связок из{' '}
                <b className="text-[var(--color-text)] tabular-nums">{data?.afterFrom ?? 0}</b> повторных покупок после «{from}»
                {' '}(<b className="text-[var(--color-text)]">{pctStr(pct)}</b>)
                {/* Все цифры шапки считаются по срезу выбранного менеджера (правка
                    владельца 11.09) — подписываем, чей это срез, чтобы «112 → 25»
                    не читалось как расхождение данных. */}
                {selected && <> · только <b className="text-[var(--color-text)]">{selected.name ?? selected.managerId}</b></>}
              </>
            )}
          </p>
          {/* Сводные цифры связки (правка владельца 11.09: «дополни дрилл важными
              связанными цифрами»). Сумма — по ЗАКРЫВАЮЩИМ сделкам: именно их
              принесла допродажа. «Доля денег» сравнивает связку со всеми
              повторными покупками после A — иногда редкая связка даёт основную выручку. */}
          {!isLoading && !error && data && (
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-2">
              <Stat label="Заказчиков" value={String(hits?.clients ?? 0)} hint={`из ${data.afterFromAgg.clients} вернувшихся`} />
              <Stat label="Сумма связок" value={fmtMln(hits?.sumNext ?? 0)} hint="закрывающие сделки" />
              <Stat label="Доля денег" value={pctStr(moneyShare)} hint={`из ${fmtMln(data.afterFromAgg.sumNext)} повторных`} />
              <Stat label="Средний чек" value={fmtMoney(avgCheck)} hint="закрывающей сделки" />
              <Stat
                label="Медиана разрыва"
                value={hits?.medianDays === null || hits === undefined ? '—' : `${hits.medianDays} дн.`}
                hint={data.afterFromAgg.medianDays !== null ? `все повторы: ${data.afterFromAgg.medianDays} дн.` : undefined}
              />
              <Stat label="Сумма исходных" value={fmtMln(hits?.sumPrev ?? 0)} hint={`«${from}» в этих парах`} />
            </div>
          )}
        </div>

        {/* Тело: на телефоне скроллится целиком, на lg+ — каждая колонка своей
            областью до низа панели (flex-1 + min-h-0). */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden lg:overflow-hidden p-3 sm:p-4">

      {error ? (
        <div className="p-10 text-center text-sm text-[var(--color-negative,#d33)]">{error instanceof Error ? error.message : String(error)}</div>
      ) : isLoading ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-9 bg-[var(--color-border)] rounded animate-pulse" />)}</div>
      ) : (
        // lg:items-stretch обязателен: при items-start грид-элемент не тянется на
        // высоту ряда, и flex-1 внутри колонок не разрешался бы — колонки снова
        // обрезались бы по контенту, как до правки 11.09.
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_1fr] items-start lg:items-stretch lg:h-full lg:min-h-0">
          {/* Кто продаёт связку */}
          <section className="min-w-0 flex flex-col lg:min-h-0">
            <h3 className="shrink-0 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5">
              Кто продаёт · {data?.managers.length ?? 0}
            </h3>
            <div className="rounded-xl border border-[var(--color-border)] overflow-hidden flex flex-col lg:flex-1 lg:min-h-0">
              <button
                onClick={() => setDrillManagerId(null)}
                className={`shrink-0 w-full min-h-11 px-3 text-left text-sm border-b border-[var(--color-border)] transition-colors ${
                  drillManagerId === null ? 'bg-[var(--color-bg-hover)] font-medium' : 'hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                Все менеджеры
              </button>
              <div className="lg:flex-1 lg:min-h-0 overflow-y-auto">
                {(data?.managers ?? []).filter(m => m.n > 0).map(m => {
                  const share = m.afterFrom > 0 ? (m.n / m.afterFrom) * 100 : 0;
                  const active = m.managerId === drillManagerId;
                  return (
                    <button
                      key={m.managerId ?? 'none'}
                      onClick={() => setDrillManagerId(active ? null : m.managerId)}
                      className={`w-full min-h-11 px-3 py-1.5 text-left border-b border-[var(--color-border)] last:border-b-0 transition-colors ${
                        active ? 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : 'hover:bg-[var(--color-bg-hover)]'
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{m.name ?? `#${m.managerId}`}</span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-text)]">{m.n}</span>
                        <span className="shrink-0 w-12 text-right text-xs tabular-nums text-[var(--color-text-muted)]">{share.toFixed(0)} %</span>
                      </div>
                      {/* Полоска — доля своих повторных покупок, а не абсолют: так видно
                          не «у кого больше клиентов», а кто реально допродаёт. */}
                      <div className="mt-1 h-1 rounded bg-[var(--color-bg-hover)] overflow-hidden">
                        <div className="h-full bg-[var(--color-accent)]" style={{ width: `${(m.n / maxN) * 100}%` }} />
                      </div>
                      <div className="mt-0.5 flex items-baseline gap-2 text-[10px] text-[var(--color-text-muted)]">
                        <span className="truncate">из {m.afterFrom} повт. покупок после «{from}»</span>
                        <span className="ml-auto shrink-0 tabular-nums">
                          {fmtMln(m.sumNext)}{m.medianDays !== null ? ` · ${m.medianDays} дн.` : ''}
                        </span>
                      </div>
                    </button>
                  );
                })}
                {(data?.managers ?? []).filter(m => m.n > 0).length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">Связок нет</div>
                )}
              </div>
            </div>
          </section>

          {/* Правая колонка: два таба (цепочки ячейки / вся строка «A → остальное») */}
          <section className="min-w-0 flex flex-col lg:min-h-0">
            {/* Настоящие табы с подчёркиванием (правка владельца 11.09: «получились
                не табы, а пилюльковый переключатель») — тот же паттерн, что TabBar
                в RewardsSettingsPage. flex-wrap вместо горизонтального скролла
                снимает класс баг-ов правила 12 CLAUDE.md (уезжающая страница). */}
            <div className="shrink-0 mb-2 flex flex-wrap items-end gap-x-1 gap-y-0 border-b border-[var(--color-border)]">
              {([
                { key: 'chains' as const, label: `${from} → ${to}`, count: data?.total ?? 0, hint: 'Цепочки сделок этой ячейки' },
                { key: 'groups' as const, label: `${from} → остальное`, count: data?.nextGroups.length ?? 0, hint: `Все товарные группы, которыми продолжали после «${from}»` },
              ]).map(o => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setTab(o.key)}
                  aria-selected={tab === o.key}
                  role="tab"
                  title={o.hint}
                  className={`min-h-11 sm:min-h-0 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors max-w-[70vw] sm:max-w-none truncate ${
                    tab === o.key
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                      : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {o.label} · {o.count}
                </button>
              ))}
              <span className="ml-auto pb-2 pl-2 text-[11px] text-[var(--color-text-muted)] min-w-0 truncate">
                {selected ? `только ${selected.name ?? selected.managerId}` : 'все менеджеры'}
                {tab === 'chains' && data?.truncated ? ' · показаны последние 300' : ''}
                {tab === 'groups' ? ` · база ${data?.nextGroupsBase ?? 0} повт. покупок` : ''}
              </span>
            </div>

            <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
              {tab === 'chains' ? (
                <div className="flex flex-col gap-2">
                  {(data?.chains ?? []).map(c => (
                    <ChainRow key={`${c.prev.dealId}-${c.next.dealId}`} chain={c} from={from} to={to} onOpenDeal={setOpenDealId} />
                  ))}
                  {(data?.chains ?? []).length === 0 && (
                    <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Нет цепочек в этом срезе</div>
                  )}
                </div>
              ) : (
                <NextGroupsTable
                  groups={data?.nextGroups ?? []} base={data?.nextGroupsBase ?? 0}
                  to={to} from={from} filters={filters}
                  drillManagerId={drillManagerId} onOpenDeal={setOpenDealId}
                />
              )}
            </div>
          </section>
        </div>
      )}

        </div>
      </div>
      {/* Карточка сделки рендерится порталом в body (см. DealCard) и ложится
          поверх панели: z-[70] против z-[61]. */}
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}
