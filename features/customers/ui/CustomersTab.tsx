'use client';
// «Мои заказчики» (фича Серёги 01.08): таб в ЛК менеджера — кому пора позвонить.
// Клиент = contact_id (физ) / company_id (юр), как в разделе «Повторные»;
// атрибуция — менеджер последней сделки клиента; сигналы (а)/(б) и пороги — в
// features/customers/engine/customers.ts. ПДн: телефоны в UI не показываются —
// звонить менеджер идёт в Битрикс по ссылке на карточку клиента/сделки.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ActiveDealInfo, CallSignal, CustomerSection, ManagerHistoryItem } from '@/features/customers/engine/customers';
import type { Recommendation } from '@/features/customers/engine/crossSell';

interface ApiRow {
  clientKey: string; clientType: 'contact' | 'company'; clientId: number; name: string | null;
  dealsTotal: number; dealsSold: number; sumSold: number;
  lastSoldAt: string | null; lastSoldAmount: number | null; lastSoldGroups: string[];
  lastCallAt: string | null; lastActivityAt: string | null;
  activeCount: number; activeDeals: ActiveDealInfo[];
  refusedNoCall: boolean; cycleDays: number; cycleSource: 'own' | 'global';
  signals: CallSignal[]; urgency: number;
  section: CustomerSection; atRisk: boolean;
  managerHistory: ManagerHistoryItem[]; prevManagerNames: string[];
  recommend: Recommendation | null;
}
interface ApiResponse {
  total: number;
  counts: {
    all: number; active: number; inactive: number; overdue: number; refusedNoCall: number;
    sections: { regular: number; regularAtRisk: number; once: number; never: number };
  };
  page: number; pageSize: number; rows: ApiRow[];
  thresholds: { globalCycleDays: number; activeNoCallDays: number; atRiskCycleMultiplier: number };
}

// Секции (доработка Серёги 01.08): постоянники сверху, купившие один раз ниже,
// «ещё не купили» — отдельная вкладка (в основном виде их нет, но сигналы по
// их активным сделкам живут там).
type Filter = 'all' | 'active' | 'inactive' | 'overdue' | 'never';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'overdue', label: 'Пора позвонить' },
  { key: 'active', label: 'С активными' },
  { key: 'inactive', label: 'Без активных' },
  { key: 'never', label: 'Ещё не купили' },
];

const SECTION_LABELS: Record<CustomerSection, string> = {
  regular: 'Постоянники',
  once: 'Купили один раз',
  never: 'Ещё не купили',
};
const SECTION_HINTS: Record<CustomerSection, string> = {
  regular: 'Клиенты с 2+ успешными сделками (по всей истории клиента, независимо от менеджера)',
  once: 'Купили один раз — кандидаты в постоянники',
  never: 'Ни одной успешной сделки; здесь живут сигналы по их активным сделкам',
};

const PAGE_SIZE = 50;

// Сортировка по заголовкам (правило владельца 01.08 «Заголовки = сортировка»,
// цикл как в /rating: убывание → возрастание → дефолт по сигналу/urgency).
// Серверная — пагинация серверная, клиентская сортировала бы только страницу.
type Sort = { key: string; dir: 'desc' | 'asc' } | null;

function useCustomers(managerId: string, isSelf: boolean, filter: Filter, search: string, page: number, sort: Sort) {
  return useQuery<ApiResponse>({
    queryKey: ['customers', isSelf ? 'me' : managerId, filter, search, page, sort?.key ?? '', sort?.dir ?? ''],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (!isSelf) qs.set('bitrixId', managerId);
      qs.set('filter', filter);
      if (search) qs.set('search', search);
      qs.set('page', String(page));
      qs.set('pageSize', String(PAGE_SIZE));
      if (sort) { qs.set('sort', sort.key); qs.set('dir', sort.dir); }
      const res = await fetch(`/api/customers?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: prev => prev, // страница не мигает при перелистывании
  });
}

function fmtMoney(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10).split('-').reverse().join('.');
}
function daysAgo(iso: string | null): string {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return 'сегодня';
  if (d === 1) return 'вчера';
  return `${d} дн. назад`;
}
function clientUrl(r: ApiRow): string {
  return r.clientType === 'contact'
    ? `https://td.monolit-crm.ru/crm/contact/details/${r.clientId}/`
    : `https://td.monolit-crm.ru/crm/company/details/${r.clientId}/`;
}

function SignalBadge({ r, noCallDays }: { r: ApiRow; noCallDays: number }) {
  if (r.signals.length === 0) {
    return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {r.signals.includes('active_no_call') && (
        <span className="inline-flex w-fit items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-bold whitespace-nowrap"
          style={{ color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 12%, transparent)' }}
          title={`Есть активная сделка, по которой нет звонков больше ${noCallDays} дней`}>
          📞 Сделка без звонка
        </span>
      )}
      {r.signals.includes('overdue_repeat') && (
        <span className="inline-flex w-fit items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] font-bold whitespace-nowrap"
          style={{ color: 'var(--color-warning, #e8590c)', backgroundColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 12%, transparent)' }}
          title={`Активных сделок нет, а с последней покупки прошло больше типичного цикла повторки клиента (${r.cycleDays} дн., ${r.cycleSource === 'own' ? 'его собственная медиана' : 'медиана по всей базе'})`}>
          ⏰ Пора позвонить
        </span>
      )}
    </div>
  );
}

// «Что предложить» (доп. Серёги 01.08): компактно топ-1 из матрицы переходов
// «группа последней покупки → следующая покупка», разворот — топ-3. При скудной
// статистике по группе клиента — общий топ по базе с пометкой.
function RecommendCell({ rec }: { rec: Recommendation | null }) {
  const [open, setOpen] = useState(false);
  if (!rec || rec.items.length === 0) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  const shown = open ? rec.items : rec.items.slice(0, 1);
  const baseTitle = rec.fallback
    ? 'По группе последней покупки клиента мало статистики переходов — показан общий топ следующих покупок по базе'
    : `Вероятность следующей покупки после: ${rec.basedOn.join(', ')} (доля таких переходов в истории продаж)`;
  return (
    <div className="flex flex-col gap-0.5" title={baseTitle}>
      {shown.map(it => (
        <div key={it.group} className="text-xs">
          <span className="whitespace-nowrap">
            <span className="text-[var(--color-text)]">{it.group}</span>
            <span className="ml-1 font-semibold tabular-nums text-[var(--color-accent)]">{it.pct}%</span>
          </span>
          {/* Награда за допродажу (доработка Серёги 01.08): какой кросс-селл
              бейдж и сколько ебаллов даст эта пара. Нет пары-бейджа — не показываем. */}
          {it.badge && (
            <div className="text-[11px] text-[var(--color-text-muted)] max-w-[220px]"
              title="Бейдж и ебаллы, которые получите, если допродадите эту группу этому клиенту">
              → {it.badge.icon} <span className="italic">«{it.badge.name}»</span>
              {it.badge.price > 0 && (
                <span className="ml-1 font-bold text-[var(--color-positive,#2f9e44)] whitespace-nowrap">+{it.badge.price}</span>
              )}
            </div>
          )}
        </div>
      ))}
      {rec.fallback && <span className="text-[10px] text-[var(--color-text-muted)]">общий топ по базе</span>}
      {rec.items.length > 1 && (
        <button type="button" onClick={() => setOpen(v => !v)}
          className="w-fit text-[11px] font-semibold text-[var(--color-accent)] hover:underline">
          {open ? 'свернуть' : `ещё ${rec.items.length - 1}`}
        </button>
      )}
    </div>
  );
}

// История менеджеров клиента (доработка Серёги 01.08): кто вёл его сделки, по
// именам НА МОМЕНТ работы (sa.employee_name_history — на логине люди меняются).
function ManagerHistoryBlock({ items }: { items: ManagerHistoryItem[] }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        История менеджеров <span className="normal-case font-normal">(имена — на момент работы с клиентом)</span>
      </div>
      <table className="text-xs">
        <tbody>
          {items.map(m => (
            <tr key={m.managerId}>
              <td className="py-0.5 pr-4 font-semibold text-[var(--color-text)]">
                {m.name ?? `Менеджер #${m.managerId}`}
              </td>
              <td className="py-0.5 pr-4 tabular-nums text-[var(--color-text-muted)] whitespace-nowrap">
                сделок {m.deals} / продано <b className="text-[var(--color-text)]">{m.sold}</b>
              </td>
              <td className="py-0.5 tabular-nums text-[var(--color-text-muted)] whitespace-nowrap">
                {fmtDate(m.firstAt)}{m.firstAt.slice(0, 10) !== m.lastAt.slice(0, 10) ? ` — ${fmtDate(m.lastAt)}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActiveDealsCell({ deals }: { deals: ActiveDealInfo[] }) {
  const [open, setOpen] = useState(false);
  if (deals.length === 0) return <span className="text-xs text-[var(--color-text-muted)]">нет</span>;
  const shown = open ? deals : deals.slice(0, 2);
  return (
    <div className="flex flex-col gap-0.5">
      {shown.map(d => (
        <div key={d.dealId} className="text-xs whitespace-nowrap">
          <a href={`https://td.monolit-crm.ru/crm/deal/details/${d.dealId}/`} target="_blank" rel="noreferrer"
            className="text-[var(--color-accent)] hover:underline" title={d.name ?? undefined}>
            #{d.dealId}
          </a>
          <span className="ml-1 text-[var(--color-text-muted)]">{d.stage ?? '?'}</span>
          {d.daysSilent > 7 && (
            <span className="ml-1 font-semibold text-[var(--color-negative,#e03131)]"
              title="Дней без звонка по этой сделке">🔇 {Math.floor(d.daysSilent)} дн.</span>
          )}
        </div>
      ))}
      {deals.length > 2 && (
        <button type="button" onClick={() => setOpen(v => !v)}
          className="w-fit text-[11px] font-semibold text-[var(--color-accent)] hover:underline">
          {open ? 'свернуть' : `ещё ${deals.length - 2}`}
        </button>
      )}
    </div>
  );
}

/** Список заказчиков одного менеджера: фильтры + поиск + пагинация.
 *  Используется и в табе ЛК, и в провале из блока РОПа. */
export function CustomersList({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>(null);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const cycleSort = (key: string) => {
    setPage(1);
    setSort(s => (s?.key !== key ? { key, dir: 'desc' } : s.dir === 'desc' ? { key, dir: 'asc' } : null));
  };

  // Дебаунс поиска, чтобы не дёргать API на каждый символ.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, isLoading, isError } = useCustomers(managerId, isSelf, filter, search, page, sort);
  const Th = ({ k, label, right = false }: { k?: string; label: string; right?: boolean }) => (
    <th className={`px-3 py-2 font-bold whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>
      {k ? (
        <button type="button" onClick={() => cycleSort(k)} title="Сортировка: убывание → возрастание → по сигналу"
          className={`uppercase tracking-wider hover:text-[var(--color-accent)] ${sort?.key === k ? 'text-[var(--color-accent)]' : ''}`}>
          {label}{sort?.key === k ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}
        </button>
      ) : label}
    </th>
  );
  const rows = data?.rows ?? [];
  const totalPages = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)), [data?.total]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-0.5">
          {FILTERS.map(f => (
            <button key={f.key} type="button" onClick={() => { setFilter(f.key); setPage(1); }}
              className={`rounded-lg px-3 py-1 text-xs font-semibold whitespace-nowrap transition-colors ${
                filter === f.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}>
              {f.label}
              {data && (
                <span className="ml-1 opacity-70 tabular-nums">
                  {f.key === 'all' ? data.counts.all : f.key === 'overdue' ? data.counts.overdue
                    : f.key === 'active' ? data.counts.active : f.key === 'inactive' ? data.counts.inactive
                    : data.counts.sections.never}
                </span>
              )}
            </button>
          ))}
        </div>
        <input value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Поиск по имени или id"
          className="min-w-[180px] flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm sm:max-w-xs" />
        {data && data.counts.refusedNoCall > 0 && (
          <span className="text-[11px] text-[var(--color-text-muted)]" title="Клиентов, у которых есть сделка, закрытая в отказ без единого звонка">
            🚫 отказы без звонка: <b className="text-[var(--color-text)]">{data.counts.refusedNoCall}</b>
          </span>
        )}
      </div>

      {isError ? (
        <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось загрузить список заказчиков.</div>
      ) : isLoading && rows.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">Считаем заказчиков… (первое открытие может занять до минуты)</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">Ничего не найдено.</div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <Th label="Клиент" />
                <Th label="Сигнал" />
                <Th k="dealsSold" label="Сделок / продано" right />
                <Th k="sumSold" label="Куплено на" right />
                <Th k="lastSoldAt" label="Последняя покупка" />
                <Th k="activeCount" label="Активные сделки" />
                <Th label="Предложить" />
                <Th k="lastCallAt" label="Последний звонок" />
                <Th k="lastActivityAt" label="Активность" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const showHeader = idx === 0 || rows[idx - 1].section !== r.section;
                const secCounts = data?.counts.sections;
                const secCount = secCounts
                  ? (r.section === 'regular' ? secCounts.regular : r.section === 'once' ? secCounts.once : secCounts.never)
                  : null;
                return (
                <Fragment key={r.clientKey}>
                {showHeader && (
                  <tr className="border-t border-[var(--color-border)] bg-[var(--color-bg-hover)]">
                    <td colSpan={9} className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
                      title={SECTION_HINTS[r.section]}>
                      {SECTION_LABELS[r.section]}
                      {secCount !== null && <span className="ml-1.5 tabular-nums normal-case font-semibold">{secCount}</span>}
                      {r.section === 'regular' && (secCounts?.regularAtRisk ?? 0) > 0 && (
                        <span className="ml-2 normal-case font-semibold" style={{ color: 'var(--color-negative, #e03131)' }}
                          title="Постоянники без активных сделок, у которых с последней покупки прошло больше двух их циклов повторки">
                          ● под угрозой: {secCounts!.regularAtRisk}
                        </span>
                      )}
                    </td>
                  </tr>
                )}
                <tr className="border-t border-[var(--color-border)] align-top"
                  style={r.atRisk ? { backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 5%, transparent)' } : undefined}>
                  <td className="px-3 py-2">
                    {/* «Под угрозой» (доработка 01.08): красная точка перед именем */}
                    {r.atRisk && (
                      <span className="mr-1" style={{ color: 'var(--color-negative, #e03131)' }}
                        title={`Постоянник под угрозой: активных сделок нет, с последней покупки прошло больше ${data?.thresholds.atRiskCycleMultiplier ?? 2}× его цикла повторки (${r.cycleDays} дн.)`}>●</span>
                    )}
                    <a href={clientUrl(r)} target="_blank" rel="noreferrer"
                      className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline">
                      {r.name ?? (r.clientType === 'contact' ? `Контакт #${r.clientId}` : `Компания #${r.clientId}`)}
                    </a>
                    <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-[var(--color-text-muted)]">
                      <span>{r.clientType === 'contact' ? 'физ' : 'юр'}</span>
                      {r.atRisk && (
                        <span className="rounded px-1 font-semibold"
                          style={{ color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 10%, transparent)' }}
                          title={`Активных сделок нет, с последней покупки прошло больше ${data?.thresholds.atRiskCycleMultiplier ?? 2}× цикла повторки клиента (${r.cycleDays} дн.) — рискуете потерять постоянника`}>
                          ⚠ под угрозой
                        </span>
                      )}
                      {r.refusedNoCall && (
                        <span className="rounded px-1 font-semibold"
                          style={{ color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 10%, transparent)' }}
                          title="У клиента есть сделка, закрытая в отказ без единого звонка">
                          🚫 отказ без звонка
                        </span>
                      )}
                    </div>
                    {/* Смена менеджера (доработка 01.08): клиент раньше был у других */}
                    {r.prevManagerNames.length > 0 && (
                      <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)] max-w-[240px]"
                        title="Менеджеры, вёдшие сделки этого клиента раньше (имена — на момент работы)">
                        ранее работал с: {r.prevManagerNames.join(', ')}
                      </div>
                    )}
                    {r.managerHistory.length > 1 && (
                      <button type="button" onClick={() => setHistoryOpen(v => (v === r.clientKey ? null : r.clientKey))}
                        className="mt-0.5 w-fit text-[11px] font-semibold text-[var(--color-accent)] hover:underline">
                        {historyOpen === r.clientKey ? 'скрыть историю менеджеров' : 'история менеджеров'}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2"><SignalBadge r={r} noCallDays={data?.thresholds.activeNoCallDays ?? 7} /></td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {r.dealsTotal} / <b>{r.dealsSold}</b>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums whitespace-nowrap">
                    {r.sumSold > 0 ? fmtMoney(r.sumSold) : '—'}
                  </td>
                  <td className="px-3 py-2" title={r.lastSoldAt ? daysAgo(r.lastSoldAt) : undefined}>
                    {/* Доп. Серёги 01.08: дата + материал + сумма последней проданной сделки */}
                    <div className="whitespace-nowrap tabular-nums">{fmtDate(r.lastSoldAt)}</div>
                    {r.lastSoldAt && (r.lastSoldGroups.length > 0 || r.lastSoldAmount !== null) && (
                      <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)] max-w-[220px]">
                        {r.lastSoldGroups.join(', ')}
                        {r.lastSoldGroups.length > 0 && r.lastSoldAmount !== null && r.lastSoldAmount > 0 && ', '}
                        {r.lastSoldAmount !== null && r.lastSoldAmount > 0 && (
                          <span className="font-semibold text-[var(--color-text)] whitespace-nowrap">{fmtMoney(r.lastSoldAmount)}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2"><ActiveDealsCell deals={r.activeDeals} /></td>
                  <td className="px-3 py-2"><RecommendCell rec={r.recommend} /></td>
                  <td className="px-3 py-2 whitespace-nowrap" title={fmtDate(r.lastCallAt)}>
                    {daysAgo(r.lastCallAt)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[var(--color-text-muted)]" title={fmtDate(r.lastActivityAt)}>
                    {daysAgo(r.lastActivityAt)}
                  </td>
                </tr>
                {historyOpen === r.clientKey && (
                  <tr>
                    <td colSpan={9} className="px-3 pb-2">
                      <ManagerHistoryBlock items={r.managerHistory} />
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1 font-semibold disabled:opacity-40 hover:bg-[var(--color-bg-hover)]">←</button>
          <span className="tabular-nums text-[var(--color-text-muted)]">стр. {page} из {totalPages} · {data?.total ?? 0} клиентов</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1 font-semibold disabled:opacity-40 hover:bg-[var(--color-bg-hover)]">→</button>
        </div>
      )}
    </div>
  );
}

export function CustomersTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-[var(--color-text-muted)]">
        Клиенты, где вы вели последнюю сделку. <b>Постоянники</b> (2+ покупок за всю историю клиента) — сверху,
        <b> ● под угрозой</b> — постоянник молчит дольше двух своих циклов повторки и активных сделок нет; ниже —
        купившие один раз (кандидаты в постоянники); не купившие ни разу — во вкладке «Ещё не купили».
        Сигналы: <b>📞 сделка без звонка</b> — по активной сделке нет звонков
        больше недели; <b>⏰ пора позвонить</b> — активных сделок нет, а с последней покупки прошло больше типичного
        цикла повторных покупок клиента. «Предложить» — какой материал клиенты чаще всего покупают следом за
        последней покупкой этого клиента (доля таких переходов в истории продаж); строкой ниже — бейдж и ебаллы,
        которые получите за такую допродажу. Имя ведёт в карточку клиента в Битриксе.
      </div>
      <CustomersList managerId={managerId} isSelf={isSelf} />
    </div>
  );
}

// ── Блок РОПа: заказчики команды (managed-depts, как «Моя команда») ──────────

interface TeamRow {
  id: number; name: string; departmentName: string | null;
  clients: number; callNow: number; overdueRepeat: number; activeNoCall: number; refusedNoCall: number;
  regulars: number; regularsAtRisk: number;
}

export function TeamCustomersBlock() {
  const [expanded, setExpanded] = useState<number | null>(null);
  const { data, isLoading } = useQuery<{ team: TeamRow[] }>({
    queryKey: ['customers-team'],
    queryFn: async () => {
      const res = await fetch('/api/customers/team');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const team = data?.team ?? [];
  if (!isLoading && team.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">Заказчики команды</h2>
        <span className="text-xs text-[var(--color-text-muted)]">у кого сколько «пора позвонить»</span>
      </div>
      {isLoading ? (
        <div className="text-sm text-[var(--color-text-muted)]">Считаем по подчинённым… (первое открытие может занять пару минут)</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="py-1.5 pr-3 font-bold">Менеджер</th>
                <th className="py-1.5 pr-3 font-bold text-right">Клиентов</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Клиентов с 2+ успешными сделками (по всей истории клиента)">Постоянников</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Постоянники без активных сделок, молчащие дольше двух своих циклов повторки">Под угрозой</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap">Пора позвонить</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Активная сделка без звонка больше недели">Сделка молчит</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Без активных сделок, последняя покупка старше цикла повторки">Заброшенные</th>
                <th className="py-1.5 font-bold text-right whitespace-nowrap" title="Клиентов со сделкой, закрытой в отказ без единого звонка">Отказы без звонка</th>
              </tr>
            </thead>
            <tbody>
              {team.map(m => (
                <Fragment key={m.id}>
                  <tr className="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-bg-hover)]"
                    onClick={() => setExpanded(e => (e === m.id ? null : m.id))}>
                    <td className="py-1.5 pr-3">
                      <span className="font-semibold text-[var(--color-text)]">{m.name}</span>
                      {m.departmentName && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{m.departmentName}</span>}
                      <span className="ml-1.5 text-[11px] text-[var(--color-accent)]">{expanded === m.id ? '▲ свернуть' : '▼ раскрыть'}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{m.clients}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">{m.regulars}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-bold"
                      style={{ color: m.regularsAtRisk > 0 ? 'var(--color-negative, #e03131)' : 'var(--color-text-muted)' }}>
                      {m.regularsAtRisk}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-bold tabular-nums"
                      style={{ color: m.callNow > 0 ? 'var(--color-negative, #e03131)' : 'var(--color-text-muted)' }}>
                      {m.callNow}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{m.activeNoCall}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{m.overdueRepeat}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.refusedNoCall}</td>
                  </tr>
                  {expanded === m.id && (
                    <tr className="border-t border-[var(--color-border)]">
                      <td colSpan={8} className="py-3 pl-2">
                        <CustomersList managerId={String(m.id)} isSelf={false} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
