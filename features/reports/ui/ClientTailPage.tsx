'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Info } from 'lucide-react';
import { DepartmentPicker, PeriodRangeControls, ProductGroupPicker, type ProductGroupOption } from './FilterBar';
import { FiltersMenu } from './FiltersMenu';
import { DealFilterButton } from './DealFilterButton';
import { ManagerPicker, Segmented } from './TransitionMatrixPage';
import { applyPreset, calendarComparisonForPreset, type DateRange } from '@/lib/period';
import type { ClientType, ProductGroupMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import type { DealFilter } from '@/lib/metrics/dealFilters';
import type { ClientTailResult, GroupRow } from '@/features/reports/engine/clientTail';

// «Вход и хвост» (задача владельца 19.10). Слева — сделки по фильтрам отчёта
// («с чего заходят»), справа — что ЭТИ ЖЕ клиенты купили после («хвост»), внизу —
// «что будет, если такие сделки убрать». Пример владельца: нерудка с чеком до
// 50 тыс. — прямая потеря ~4 млн/мес, но клиенты после щебня могли брать бетон,
// арматуру, кровлю. Математика и определения — в шапке engine/clientTail.ts.
// Маржи в отчёте нет (правка владельца 19.10): вместо неё — сделки, отгрузки и
// CR в отгрузку. Правило владельца: у КАЖДОГО элемента видна подпись «что и как
// считаем» — не в hover-подсказке (на таче её не увидеть), а текстом рядом.

// Вход — всегда первичные отгрузки периода (правка владельца 19.10), «До входа» нет.

type Person = { id: string; name: string; department: string | null; branch: string | null };
type Window = '3' | '6' | '12' | 'all';

const rub = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1).replace('.', ',')} млн ₽`;
  if (a >= 1e3) return `${Math.round(v / 1e3).toLocaleString('ru-RU')} тыс. ₽`;
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
};
const num = (v: number) => Math.round(v).toLocaleString('ru-RU');
const cr = (shipments: number, created: number) =>
  created > 0 ? `${((shipments / created) * 100).toFixed(1).replace('.', ',')}%` : '—';

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

/** label — что это, how — как считаем (виден всегда), sub — доп. цифра. */
function Kpi({ label, value, how, sub, accent = false }: { label: string; value: string; how: string; sub?: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="text-[11px] font-medium text-[var(--color-text)]">{label}</div>
      <div className={`text-base sm:text-lg font-semibold tabular-nums truncate ${accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-text)] tabular-nums">{sub}</div>}
      <div className="mt-0.5 text-[10px] leading-snug text-[var(--color-text-muted)]">{how}</div>
    </div>
  );
}

function GroupTable({ rows, total, scopeLabel, showAlsoCut = false, legend }: {
  rows: GroupRow[]; total: number; scopeLabel: string; showAlsoCut?: boolean; legend: string;
}) {
  if (rows.length === 0) {
    return <div className="py-6 text-center text-xs text-[var(--color-text-muted)]">Нет сделок и отгрузок</div>;
  }
  return (
    <div className="flex flex-col gap-1.5">
    <div className="scroll-x">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] text-[var(--color-text-muted)] text-right">
            <th className="text-left font-medium py-1.5 pr-2">Товарная группа</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">Выручка отгр.</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">Доля выручки</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">Сделки ({scopeLabel})</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">Отгрузки ({scopeLabel})</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">CR в отгр.</th>
            <th className="font-medium py-1.5 pl-2 whitespace-nowrap">Клиентов</th>
            {showAlsoCut && <th className="font-medium py-1.5 pl-2 whitespace-nowrap">Тоже под отсеч.</th>}
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
                <td className="py-1.5 px-2 whitespace-nowrap">{r.amount ? rub(r.amount) : '—'}</td>
                <td className="py-1.5 px-2">{share.toFixed(share >= 10 ? 0 : 1)}%</td>
                <td className="py-1.5 px-2">{num(r.created)}</td>
                <td className="py-1.5 px-2">{num(r.shipments)}</td>
                <td className="py-1.5 px-2">{cr(r.shipments, r.created)}</td>
                <td className="py-1.5 pl-2">{num(r.clients)}</td>
                {showAlsoCut && <td className="py-1.5 pl-2 whitespace-nowrap text-[var(--color-text-muted)]">{r.alsoCutAmount ? rub(r.alsoCutAmount) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    <p className="text-[10px] leading-snug text-[var(--color-text-muted)]">{legend}</p>
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
    clientType, productGroupMode, productGroupIds,
    createdTimeFilter, firstTouchFilter, dealFilters,
    windowMonths: win === 'all' ? null : Number(win),
  }), [period, departmentIds, manager, clientType, productGroupMode, productGroupIds, createdTimeFilter, firstTouchFilter, dealFilters, win]);

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
  const scope = 'первичные';
  const tailWindow = win === 'all' ? 'до сегодня' : `в течение ${win} мес.`;
  const scenarios = e && t ? [
    {
      label: 'Минимум: только сами входные отгрузки',
      hint: 'Считаем, что клиенты продолжат покупать остальное как ни в чём не бывало. = выручка входа.',
      amount: e.amount,
    },
    {
      label: 'Максимум: + весь хвост этих клиентов',
      hint: 'Вход + хвост: если, отказав в такой сделке, теряем клиента целиком — со всеми его последующими покупками.',
      amount: e.amount + t.amount,
    },
  ] : [];

  const filterMenuProps = {
    dealScope: 'primary' as const, onDealScopeChange: () => {}, hideDealScope: true,
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
          <b className="font-medium text-[var(--color-text)]">Вход</b> — первичные отгрузки периода по фильтрам («с чего клиенты заходят»).{' '}
          <b className="font-medium text-[var(--color-text)]">Хвост</b> — все отгрузки этих же клиентов после их первой входной отгрузки:
          любые товары и воронки, сами входные не повторяются.{' '}
          Выручка везде — сумма отгруженных сделок по дате отгрузки; воронки 4 и 7 не учитываются.
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
              <Card title="Вход — сделки по фильтрам" hint="Только первичные (по воронке сделки) отгрузки периода, прошедшие все фильтры. Это то, что убираем." >
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <Kpi label="Выручка входа" value={rub(e.amount)} sub={perMonth(e.amount)} accent
                    how="Сумма сделок по фильтрам, отгруженных в периоде" />
                  <Kpi label={`Сделки (${scope})`} value={num(e.created)}
                    how="Созданы в периоде, те же фильтры" />
                  <Kpi label={`Отгрузки (${scope})`} value={num(e.shipments)} sub={e.shipments ? `ср. чек ${rub(e.amount / e.shipments)}` : undefined}
                    how="Отгружены в периоде, те же фильтры" />
                  <Kpi label={`CR Сделка → Отгрузка (${scope})`} value={cr(e.shipments, e.created)}
                    how="Отгрузки периода ÷ сделки периода (события окна, не путь одних и тех же сделок)" />
                  <Kpi label="Клиентов во входе" value={num(e.clients)}
                    how="Разных клиентов с входной отгрузкой — по ним считается хвост" />
                </div>
                {e.noClientDeals > 0 && (
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    {num(e.noClientDeals)} отгр. на {rub(e.noClientAmount)} без привязки к клиенту — в выручке входа есть, хвост по ним не отследить.
                  </p>
                )}
                <GroupTable rows={data.entryByGroup} total={e.amount} scopeLabel={scope}
                  legend="Группа — по наибольшей позиции сделки. Выручка и отгрузки — по дате отгрузки в периоде, сделки — по дате создания в периоде; CR = отгрузки ÷ сделки группы. Клиентов — с отгрузкой этой группы." />
              </Card>

              <Card
                title="Хвост — что эти клиенты купили потом"
                hint={`Все отгрузки клиентов входа после их первой входной отгрузки, ${tailWindow}. Любые товары, все воронки; сами входные отгрузки не считаются.`}
              >
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <Kpi label="Выручка хвоста" value={rub(t.amount)} accent
                    how="Сумма отгрузок этих клиентов после первой входной" />
                  <Kpi label="Сделки (все воронки)" value={num(t.created)}
                    how="Созданы этими клиентами после первой входной отгрузки" />
                  <Kpi label="Отгрузки (все воронки)" value={num(t.shipments)} sub={t.shipments ? `ср. чек ${rub(t.amount / t.shipments)}` : undefined}
                    how="Отгружены после первой входной, кроме самих входных" />
                  <Kpi label="CR Сделка → Отгрузка" value={cr(t.shipments, t.created)}
                    how="Отгрузки хвоста ÷ сделки хвоста" />
                  <Kpi label="Клиентов с хвостом" value={num(t.clients)} sub={e.clients ? `${Math.round((t.clients / e.clients) * 100)}% из ${num(e.clients)}` : undefined}
                    how="Сколько клиентов входа потом ещё что-то купили" />
                  <Kpi label="Хвост к входу" value={multiplier ? `×${multiplier.toFixed(1).replace('.', ',')}` : '—'}
                    how="(Выручка входа + хвоста) ÷ выручка входа" />
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  {t.alsoCutAmount > 0 && <>Из хвоста {rub(t.alsoCutAmount)} ({num(t.alsoCutDeals)} отгр.) сами подходят под фильтры входа (только позже периода) — их бы тоже отсекли.</>}
                </p>
                <GroupTable rows={data.tailByGroup} total={t.amount} scopeLabel="все воронки" showAlsoCut
                  legend="Группа — по наибольшей позиции сделки. Отгрузки и сделки хвоста — после первой входной отгрузки клиента; CR = отгрузки ÷ сделки группы. «Тоже под отсеч.» — выручка тех отгрузок хвоста, что сами подходят под фильтры входа." />
              </Card>
            </div>

            <Card title="Что будет, если убрать такие сделки" hint="Сколько выручки потеряем, если перестать брать входные сделки, — две оценки: «клиенты никуда не денутся» и «теряем клиента целиком».">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {scenarios.map((s, i) => (
                  <div key={s.label} className={`min-w-0 rounded-lg border px-3 py-2.5 ${i === 1 ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'} bg-[var(--color-bg)]`}>
                    <div className="text-xs font-medium text-[var(--color-text)]">{s.label}</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums text-[var(--color-text)]">−{rub(s.amount)}</div>
                    {months >= 1.5 && (
                      <div className="text-[11px] tabular-nums text-[var(--color-text-muted)]">≈ −{rub(s.amount / months)} в мес.</div>
                    )}
                    <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{s.hint}</div>
                  </div>
                ))}
              </div>
              <p className="flex items-start gap-1.5 text-[11px] text-[var(--color-text-muted)]">
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>
                  «В месяц» — сумма ÷ длина периода ({months.toFixed(1).replace('.', ',')} мес.). У клиентов, зашедших в конце периода,
                  хвост ещё не успел нарасти — для честной оценки берите период, закончившийся несколько месяцев назад.
                </span>
              </p>
            </Card>

            <Card
              title="Клиенты"
              hint={`Топ-${data.clients.length} из ${num(data.clientsTotal)} клиентов входа по выручке хвоста.`}
            >
              <div className="scroll-x">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--color-text-muted)] text-right align-bottom">
                      <th className="text-left font-medium py-1.5 pr-2">Клиент</th>
                      <th className="font-medium py-1.5 px-2">Первая входная<br />отгрузка</th>
                      <th className="font-medium py-1.5 px-2">Вход<br /><span className="font-normal">перв. отгрузки по фильтрам</span></th>
                      <th className="font-medium py-1.5 px-2">Хвост<br /><span className="font-normal">отгрузки после</span></th>
                      <th className="text-left font-medium py-1.5 pl-2">Что брал потом<br /><span className="font-normal">главные группы хвоста</span></th>
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
                        </td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{new Date(c.firstEntryAt).toLocaleDateString('ru-RU')}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{rub(c.entryAmount)}<div className="text-[10px] text-[var(--color-text-muted)]">{c.entryShipments} отгр.</div></td>
                        <td className="py-1.5 px-2 whitespace-nowrap font-medium">{c.tailAmount ? rub(c.tailAmount) : '—'}{c.tailShipments > 0 && <div className="text-[10px] font-normal text-[var(--color-text-muted)]">{c.tailShipments} отгр.</div>}</td>
                        <td className="text-left py-1.5 pl-2 text-xs text-[var(--color-text-muted)] min-w-[160px]">{c.tailGroups.join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] leading-snug text-[var(--color-text-muted)]">
                Вход — сумма ВСЕХ первичных отгрузок клиента в периоде, прошедших фильтры. Хвост — все его отгрузки после первой входной
                ({tailWindow}), любые товары и воронки, без самих входных.
              </p>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
