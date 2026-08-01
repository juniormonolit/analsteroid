'use client';

// «Геймификация → Дашборд» (задача 2741): первая вкладка раздела настроек —
// живая сводка экономики ебаллов/рублей. Данные — /api/settings/badges/dashboard
// (read-only, gамификационный движок не трогается). Методика виджета «здоровье
// экономики» — owners-inbox/monolitika-sink-mechanics.md.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface BalanceRow {
  bitrixId: number; name: string; department: string | null;
  eball: number; rub: number; earned30: number; spent30: number;
}
interface EmissionBySource { auto: number; quest: number; manual: number; retro: number; total: number }
interface AbsorptionBySource {
  shop: number; gacha: number; reroll: number; burn: number;
  commission: number; penalty: number; deposit: number; total: number;
}
interface DashboardData {
  currencyName: string;
  balances: BalanceRow[];
  emission: EmissionBySource;
  prevEmissionTotal: number;
  emissionMomPct: number | null;
  absorption: AbsorptionBySource;
  health: { emission: number; absorption: number; freeSinkAmount: number; freeSinkShare: number | null; toBurn30d: number };
  circulation: { totalEball: number; totalRub: number };
}

function num(n: number): string {
  return n.toLocaleString('ru-RU');
}

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 ${className ?? ''}`}>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h3>
      {children}
    </div>
  );
}

function SourceRow({ label, value, currencyName }: { label: string; value: number; currencyName: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="tabular-nums font-medium">{num(value)} {currencyName}</span>
    </div>
  );
}

type SortKey = 'name' | 'department' | 'eball' | 'rub' | 'earned30' | 'spent30';
type SortState = { key: SortKey; dir: 'desc' | 'asc' };

function SortableTh({ label, sortKey, sort, onSort, left }: {
  label: string; sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void; left?: boolean;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      title="Сортировать по колонке"
      className={`px-3 py-2.5 ${left ? 'text-left' : 'text-right'} font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] ${active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}
    >
      {label}
      <span className="inline-block w-3 text-[10px]">{active ? (sort.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

export function GamificationDashboard() {
  const { data, isLoading, isError } = useQuery<DashboardData>({
    queryKey: ['gamification-dashboard'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/dashboard');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const [sort, setSort] = useState<SortState>({ key: 'eball', dir: 'desc' });
  const onSort = (key: SortKey) => setSort(s => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  const rows = data?.balances ?? [];
  const sortedRows = useMemo(() => {
    const mult = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      if (sort.key === 'name') return mult * a.name.localeCompare(b.name, 'ru');
      if (sort.key === 'department') return mult * (a.department ?? '').localeCompare(b.department ?? '', 'ru');
      return mult * (Number(a[sort.key]) - Number(b[sort.key]));
    });
  }, [rows, sort]);

  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>;
  if (isError || !data) return <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить дашборд.</p>;

  const { currencyName, emission, absorption, health, circulation, emissionMomPct } = data;
  const freeSinkPct = health.freeSinkShare === null ? null : Math.round(health.freeSinkShare * 1000) / 10;
  const freeSinkOk = freeSinkPct !== null && freeSinkPct >= 25 && freeSinkPct <= 35;
  const netFlow = health.emission - health.absorption;

  return (
    <div className="flex flex-col gap-4">
      {/* Агрегаты в обращении */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card title={`Всего в обращении, ${currencyName}`}>
          <div className="text-2xl font-semibold tabular-nums">{num(circulation.totalEball)}</div>
        </Card>
        <Card title="Всего в обращении, ₽">
          <div className="text-2xl font-semibold tabular-nums">{num(circulation.totalRub)}</div>
        </Card>
        <Card title="Эмиссия за месяц">
          <div className="text-2xl font-semibold tabular-nums">{num(emission.total)}</div>
          {emissionMomPct !== null && (
            <div className={`text-xs mt-1 ${emissionMomPct >= 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
              {emissionMomPct >= 0 ? '▲' : '▼'} {Math.abs(emissionMomPct)}% к пред. месяцу
            </div>
          )}
        </Card>
        <Card title="Поглощение за месяц">
          <div className="text-2xl font-semibold tabular-nums">{num(health.absorption)}</div>
          <div className={`text-xs mt-1 ${netFlow >= 0 ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-positive)]'}`}>
            нетто {netFlow >= 0 ? '+' : ''}{num(netFlow)}
          </div>
        </Card>
      </div>

      {/* Здоровье экономики */}
      <Card title="Здоровье экономики" className="border-2" >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1">Доля «бесплатных» синков (гача + нематериал. каталог + сгорание)</div>
            <div className={`text-xl font-semibold tabular-nums ${freeSinkPct === null ? '' : freeSinkOk ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
              {freeSinkPct === null ? '—' : `${freeSinkPct}%`}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">цель 25–35% (monolitika-sink-mechanics.md, реком. №3)</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1">К сгоранию в ближайшие 30 дней</div>
            <div className="text-xl font-semibold tabular-nums">{num(health.toBurn30d)} {currencyName}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1">Эмиссия vs поглощение (месяц)</div>
            <div className="text-xl font-semibold tabular-nums">{num(health.emission)} / {num(health.absorption)}</div>
          </div>
        </div>
      </Card>

      {/* Эмиссия / поглощение по source */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card title="Эмиссия по источникам (месяц)">
          <SourceRow label="Авто-награды" value={emission.auto} currencyName={currencyName} />
          <SourceRow label="Квесты" value={emission.quest} currencyName={currencyName} />
          <SourceRow label="Ручные" value={emission.manual} currencyName={currencyName} />
          <SourceRow label="Ретро / релизный старт" value={emission.retro} currencyName={currencyName} />
          <div className="mt-2 border-t border-[var(--color-border)] pt-2">
            <SourceRow label="Итого" value={emission.total} currencyName={currencyName} />
          </div>
        </Card>
        <Card title="Поглощение по источникам (месяц)">
          <SourceRow label="Магазин" value={absorption.shop} currencyName={currencyName} />
          <SourceRow label="Гача (нетто)" value={absorption.gacha} currencyName={currencyName} />
          <SourceRow label="Реролл" value={absorption.reroll} currencyName={currencyName} />
          <SourceRow label="Сгорание (TTL)" value={absorption.burn} currencyName={currencyName} />
          <SourceRow label="Комиссии переводов" value={absorption.commission} currencyName={currencyName} />
          <SourceRow label="Штрафы" value={absorption.penalty} currencyName={currencyName} />
          <SourceRow label="Депозиты контрактов" value={absorption.deposit} currencyName={currencyName} />
          <div className="mt-2 border-t border-[var(--color-border)] pt-2">
            <SourceRow label="Итого" value={absorption.total} currencyName={currencyName} />
          </div>
        </Card>
      </div>

      {/* Балансы по сотрудникам */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-muted)]">Балансы по сотрудникам</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Пока нет данных по леджеру.</p>
        ) : (
          <div className="scroll-x rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[var(--color-table-header)]">
                  <SortableTh label="Сотрудник" sortKey="name" sort={sort} onSort={onSort} left />
                  <SortableTh label="Отдел" sortKey="department" sort={sort} onSort={onSort} left />
                  <SortableTh label={currencyName} sortKey="eball" sort={sort} onSort={onSort} />
                  <SortableTh label="₽" sortKey="rub" sort={sort} onSort={onSort} />
                  <SortableTh label="Заработано 30д" sortKey="earned30" sort={sort} onSort={onSort} />
                  <SortableTh label="Потрачено 30д" sortKey="spent30" sort={sort} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r, i) => (
                  <tr
                    key={r.bitrixId}
                    className={`border-t border-[var(--color-border)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap font-medium">{r.name}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{r.department ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(r.eball)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(r.rub)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--color-positive)]">{num(r.earned30)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--color-negative)]">{num(r.spent30)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
