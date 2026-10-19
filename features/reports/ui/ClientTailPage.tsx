'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Info } from 'lucide-react';
import { DepartmentPicker, PeriodRangeControls, ProductGroupPicker, type ProductGroupOption } from './FilterBar';
import { FiltersMenu } from './FiltersMenu';
import { DealFilterButton } from './DealFilterButton';
import { ManagerPicker, Segmented } from './TransitionMatrixPage';
import { applyPreset, calendarComparisonForPreset, type DateRange } from '@/lib/period';
import type { DealScope, ClientType, ProductGroupMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import type { DealFilter } from '@/lib/metrics/dealFilters';
import type { ClientTailResult, GroupRow } from '@/features/reports/engine/clientTail';

// «Вход и хвост» (задача владельца 19.10). Слева — сделки по фильтрам отчёта
// («с чего заходят»), справа — что ЭТИ ЖЕ клиенты купили после («хвост»), внизу —
// «что будет, если такие сделки убрать». Пример владельца: нерудка с чеком до
// 50 тыс. — прямая потеря ~4 млн/мес, но клиенты после щебня могли брать бетон,
// арматуру, кровлю. Математика и определения — в шапке engine/clientTail.ts.
// Маржа — оценка ~10 % от выручки (решение владельца 19.10), всегда с «~».

const MARGIN_RATE = 0.1;

type Person = { id: string; name: string; department: string | null; branch: string | null };
type Window = '3' | '6' | '12' | 'all';

const rub = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1).replace('.', ',')} млн ₽`;
  if (a >= 1e3) return `${Math.round(v / 1e3).toLocaleString('ru-RU')} тыс. ₽`;
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
};
const margin = (v: number) => `~${rub(v * MARGIN_RATE)}`;
const num = (v: number) => Math.round(v).toLocaleString('ru-RU');

async function fetchTail(body: unknown): Promise<ClientTailResult> {
  const res = await fetch('/api/reports/client-tail', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function Kpi({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="text-[11px] text-[var(--color-text-muted)] truncate">{label}</div>
      <div className={`text-base sm:text-lg font-semibold tabular-nums truncate ${accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-text-muted)] tabular-nums truncate">{sub}</div>}
    </div>
  );
}

function GroupTable({ rows, total, showAlsoCut = false }: { rows: GroupRow[]; total: number; showAlsoCut?: boolean }) {
  if (rows.length === 0) {
    return <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">Нет отгрузок</div>;
  }
  return (
    <div className="scroll-x">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] text-[var(--color-text-muted)] text-right">
            <th className="text-left font-medium py-1.5 pr-2">Товарная группа</th>
            <th className="font-medium py-1.5 px-2">Выручка</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">~Маржа</th>
            <th className="font-medium py-1.5 px-2">Доля</th>
            <th className="font-medium py-1.5 px-2">Сделок</th>
            <th className="font-medium py-1.5 pl-2">Клиентов</th>
            {showAlsoCut && <th className="font-medium py-1.5 pl-2 whitespace-nowrap" title="Часть хвоста, которая сама подходит под условия входа — при отсечении её бы тоже не было">Тоже под отсеч.</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const share = total > 0 ? (r.amount / total) * 100 : 0;
            return (
              <tr key={r.group} className="border-t border-[var(--color-border)] text-right tabular-nums">
                <td className="text-left py-1.5 pr-2 max-w-[180px]">
                  <div className="truncate" title={r.group}>{r.group}</div>
                  <div className="mt-0.5 h-1 rounded bg-[var(--color-accent)]/70" style={{ width: `${Math.max(share, 1)}%` }} />
                </td>
                <td className="py-1.5 px-2 whitespace-nowrap">{rub(r.amount)}</td>
                <td className="py-1.5 px-2 whitespace-nowrap text-[var(--color-text-muted)]">{margin(r.amount)}</td>
                <td className="py-1.5 px-2">{share.toFixed(share >= 10 ? 0 : 1)}%</td>
                <td className="py-1.5 px-2">{num(r.deals)}</td>
                <td className="py-1.5 pl-2">{num(r.clients)}</td>
                {showAlsoCut && <td className="py-1.5 pl-2 whitespace-nowrap text-[var(--color-text-muted)]">{r.alsoCutAmount ? rub(r.alsoCutAmount) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
        {hint && <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function ClientTailPage() {
  const [period, setPeriod] = useState<DateRange>(() => applyPreset('this_year'));
  const [comparison, setComparison] = useState<DateRange>(() => calendarComparisonForPreset('this_year'));
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [manager, setManager] = useState<Person | null>(null);
  const [dealScope, setDealScope] = useState<DealScope>('all');
  const [clientType, setClientType] = useState<ClientType>('all');
  const [productGroupMode, setProductGroupMode] = useState<ProductGroupMode>('by_max');
  const [productGroupIds, setProductGroupIds] = useState<string[]>([]);
  const [createdTimeFilter, setCreatedTimeFilter] = useState<CreatedTimeFilter>('all');
  const [firstTouchFilter, setFirstTouchFilter] = useState<FirstTouchFilter>('all');
  const [dealFilters, setDealFilters] = useState<DealFilter[]>([]);
  const [win, setWin] = useState<Window>('all');

  const { data: pgData, isLoading: pgLoading } = useQuery<{ groups: ProductGroupOption[] }>({
    queryKey: ['catalog-product-groups', productGroupMode],
    queryFn: async () => {
      const res = await fetch(`/api/catalog/product-groups?mode=${productGroupMode}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
  });

  const body = useMemo(() => ({
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    departmentIds,
    managerIds: manager ? [manager.id] : [],
    dealScope, clientType, productGroupMode, productGroupIds,
    createdTimeFilter, firstTouchFilter, dealFilters,
    windowMonths: win === 'all' ? null : Number(win),
  }), [period, departmentIds, manager, dealScope, clientType, productGroupMode, productGroupIds, createdTimeFilter, firstTouchFilter, dealFilters, win]);

  const { data, isLoading, isFetching, error } = useQuery<ClientTailResult>({
    queryKey: ['client-tail', body],
    queryFn: () => fetchTail(body),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Месяцев в периоде — для «≈ в месяц» (гипотеза владельца сформулирована помесячно).
  const months = Math.max((period.to.getTime() - period.from.getTime()) / 86_400_000 + 1, 1) / 30.44;
  const perMonth = (v: number) => (months >= 1.5 ? `≈ ${rub(v / months)} в мес.` : undefined);

  const e = data?.entry;
  const t = data?.tail;
  const multiplier = e && t && e.amount > 0 ? (e.amount + t.amount) / e.amount : null;
  const scenarios = e && t ? [
    {
      label: 'Минимум: только сами сделки',
      hint: 'Клиенты продолжат покупать остальное как ни в чём не бывало.',
      amount: e.amount,
    },
    {
      label: 'Реалистично: + хвост клиентов, пришедших через эти сделки',
      hint: `Для ${num(e.newClients)} из ${num(e.clients)} клиентов входная сделка была самой первой покупкой — без неё их могло и не быть вовсе.`,
      amount: e.amount + t.newClientsAmount,
    },
    {
      label: 'Максимум: + весь хвост всех этих клиентов',
      hint: 'Если, отказав в мелкой сделке, теряем клиента целиком — включая давних.',
      amount: e.amount + t.amount,
    },
  ] : [];

  const filterMenuProps = {
    dealScope, onDealScopeChange: setDealScope,
    clientType, onClientTypeChange: setClientType,
    showProductGroupPicker: true, productGroupMode,
    onProductGroupModeChange: (m: ProductGroupMode) => { setProductGroupMode(m); setProductGroupIds([]); },
    createdTimeFilter, onCreatedTimeFilterChange: setCreatedTimeFilter,
    firstTouchFilter, onFirstTouchFilterChange: setFirstTouchFilter,
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="px-3 sm:px-6 py-3 border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Вход и хвост</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5 max-w-4xl">
          Слева — отгрузки периода по фильтрам («с чего клиенты заходят»). Справа — всё, что эти же клиенты
          купили после своей первой такой сделки («хвост»). Внизу — сколько выручки потеряем, если такие сделки убрать.
          Маржа — оценка: ~10 % от выручки.
        </p>
      </div>

      <div className="flex items-center gap-2 px-3 sm:px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
        <PeriodRangeControls
          period={period} comparison={comparison}
          onPeriodChange={setPeriod} onComparisonChange={setComparison}
          showComparison={false}
        />
        <DepartmentPicker departmentIds={departmentIds} onDepartmentIdsChange={setDepartmentIds} />
        <ManagerPicker value={manager} onChange={setManager} />
        <ProductGroupPicker
          productGroupIds={productGroupIds} onProductGroupIdsChange={setProductGroupIds}
          options={pgData?.groups ?? []} loading={pgLoading}
        />
        <DealFilterButton value={dealFilters} onChange={setDealFilters} />
        <FiltersMenu {...filterMenuProps} />
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">Хвост:</span>
          <Segmented ariaLabel="Окно хвоста" value={win} onChange={setWin}
            options={[{ key: '3', label: '3 мес' }, { key: '6', label: '6 мес' }, { key: '12', label: '12 мес' }, { key: 'all', label: 'Всё время' }]} />
        </div>
        {isFetching && !isLoading && <span className="text-xs text-[var(--color-text-muted)]">Обновляю…</span>}
      </div>

      <div className="px-3 sm:px-6 py-4 flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-[var(--color-negative)]/40 px-3 py-2 text-sm text-[var(--color-negative)]">
            {(error as Error).message}
          </div>
        )}
        {isLoading && <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Считаю вход и хвост…</div>}

        {e && t && data && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card title="Вход — сделки по фильтрам" hint="Отгрузки периода, прошедшие все фильтры. Это то, что убираем.">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Kpi label="Выручка" value={rub(e.amount)} sub={perMonth(e.amount)} accent />
                  <Kpi label="~Маржа" value={margin(e.amount)} sub={months >= 1.5 ? `≈ ${margin(e.amount / months)} в мес.` : undefined} />
                  <Kpi label="Сделок" value={num(e.deals)} sub={e.deals ? `ср. чек ${rub(e.amount / e.deals)}` : undefined} />
                  <Kpi label="Клиентов" value={num(e.clients)} sub={`${num(e.newClients)} — первая покупка`} />
                </div>
                {e.noClientDeals > 0 && (
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    {num(e.noClientDeals)} сделок на {rub(e.noClientAmount)} без привязки к клиенту — во вход входят, хвост по ним не отследить.
                  </p>
                )}
                <GroupTable rows={data.entryByGroup} total={e.amount} />
              </Card>

              <Card
                title="Хвост — что эти клиенты купили потом"
                hint={`Отгрузки тех же клиентов после первой входной сделки${win === 'all' ? ', до сегодня' : `, в течение ${win} мес.`} Сами входные сделки не повторяются.`}
              >
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <Kpi label="Выручка хвоста" value={rub(t.amount)} accent />
                  <Kpi label="~Маржа" value={margin(t.amount)} />
                  <Kpi label="Клиентов с хвостом" value={num(t.clients)} sub={e.clients ? `${Math.round((t.clients / e.clients) * 100)}% из ${num(e.clients)}` : undefined} />
                  <Kpi label="Хвост к входу" value={multiplier ? `×${multiplier.toFixed(1).replace('.', ',')}` : '—'} sub="(вход + хвост) / вход" />
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  {t.alsoCutAmount > 0 && <>Из хвоста {rub(t.alsoCutAmount)} ({num(t.alsoCutDeals)} сд.) сами подходят под фильтры входа — их бы тоже отсекли. </>}
                  До входа эти клиенты уже принесли {rub(data.before.amount)} ({num(data.before.clients)} клиентов покупали раньше).
                </p>
                <GroupTable rows={data.tailByGroup} total={t.amount} showAlsoCut />
              </Card>
            </div>

            <Card title="Что будет, если убрать такие сделки" hint="Три оценки потерь — от «клиенты никуда не денутся» до «теряем клиента целиком».">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {scenarios.map((s, i) => (
                  <div key={s.label} className={`min-w-0 rounded-lg border px-3 py-2.5 ${i === 1 ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'} bg-[var(--color-bg)]`}>
                    <div className="text-xs font-medium text-[var(--color-text)]">{s.label}</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums text-[var(--color-text)]">−{rub(s.amount)}</div>
                    <div className="text-sm tabular-nums text-[var(--color-text-muted)]">маржа −{margin(s.amount)}</div>
                    {months >= 1.5 && (
                      <div className="text-[11px] tabular-nums text-[var(--color-text-muted)]">≈ −{rub(s.amount / months)} / −{margin(s.amount / months)} в мес.</div>
                    )}
                    <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{s.hint}</div>
                  </div>
                ))}
              </div>
              <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>
                  «В месяц» — за период ({months.toFixed(1).replace('.', ',')} мес.). У клиентов, зашедших в конце периода,
                  хвост ещё не успел нарасти — для честной оценки берите период, закончившийся несколько месяцев назад.
                </span>
              </p>
            </Card>

            <Card
              title="Клиенты"
              hint={`Топ-${data.clients.length} из ${num(data.clientsTotal)} по выручке хвоста.`}
            >
              <div className="scroll-x">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--color-text-muted)] text-right">
                      <th className="text-left font-medium py-1.5 pr-2">Клиент</th>
                      <th className="font-medium py-1.5 px-2 whitespace-nowrap">Первый вход</th>
                      <th className="font-medium py-1.5 px-2">Вход</th>
                      <th className="font-medium py-1.5 px-2">Хвост</th>
                      <th className="font-medium py-1.5 px-2 whitespace-nowrap">До входа</th>
                      <th className="text-left font-medium py-1.5 pl-2">Что брал потом</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.clients.map(c => (
                      <tr key={c.contactId} className="border-t border-[var(--color-border)] text-right tabular-nums align-top">
                        <td className="text-left py-1.5 pr-2 max-w-[220px]">
                          <a
                            href={`https://td.monolit-crm.ru/crm/contact/details/${c.contactId}/`}
                            target="_blank" rel="noreferrer"
                            className="inline-flex items-center gap-1 max-w-full hover:text-[var(--color-accent)]"
                          >
                            <span className="truncate">{c.name ?? `Контакт #${c.contactId}`}</span>
                            <ExternalLink size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                          </a>
                          {c.isNew && <div className="text-[10px] text-[var(--color-accent)]">первая покупка</div>}
                        </td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{new Date(c.firstEntryAt).toLocaleDateString('ru-RU')}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{rub(c.entryAmount)}<div className="text-[10px] text-[var(--color-text-muted)]">{c.entryDeals} сд.</div></td>
                        <td className="py-1.5 px-2 whitespace-nowrap font-medium">{c.tailAmount ? rub(c.tailAmount) : '—'}{c.tailDeals > 0 && <div className="text-[10px] font-normal text-[var(--color-text-muted)]">{c.tailDeals} сд.</div>}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap text-[var(--color-text-muted)]">{c.beforeAmount ? rub(c.beforeAmount) : '—'}</td>
                        <td className="text-left py-1.5 pl-2 text-xs text-[var(--color-text-muted)] min-w-[160px]">{c.tailGroups.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
