'use client';

// «Геймификация → Дашборд» (задача 2741): первая вкладка раздела настроек —
// живая сводка экономики MLT/рублей (валюта переименована из «ебаллов» в MLT,
// задача 2747). Данные — /api/settings/badges/dashboard (read-only,
// гамификационный движок не трогается). Методика виджета «здоровье экономики»
// — owners-inbox/monolitika-sink-mechanics.md.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MltCoin } from '@/components/icons/MltCoin';

interface BalanceRow {
  bitrixId: number; name: string; department: string | null;
  eball: number; rub: number; earned30: number; spent30: number;
}
interface EmissionBySource { auto: number; quest: number; manual: number; retro: number; total: number }
interface AbsorptionBySource {
  shop: number; gacha: number; reroll: number; burn: number;
  commission: number; penalty: number; deposit: number; total: number;
}
interface XpRow {
  bitrixId: number; name: string; department: string | null;
  totalXp: number; xp30: number; level: number; title: string;
  topClass: { name: string; level: number } | null;
}
interface XpSummary {
  totalXp: number; monthXp: number; medianLevel: number; topLevel: number;
  titleCounts: Record<string, number>;
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
  // Рублёвая смета (правка владельца 05.08): фактическая стоимость геймификации.
  rubEconomics: {
    rate: number; budgetRub: number; budgetUsedRub: number; budgetForecastRub: number;
    onHandMlt: number; onHandRub: number;
    emittedAllMlt: number; emittedAllRub: number;
    emittedMonthMlt: number; emittedMonthRub: number;
    spentMaterialRub: number; spentPayoutRub: number; spentTotalRub: number;
    immaterialRub: number; pendingRub: number;
  };
  xp: { summary: XpSummary; rows: XpRow[] };
}

// Порядок титулов для сводки (Стажёр → Легенда) — фиксированный, не по алфавиту.
const TITLE_ORDER = ['Стажёр', 'Боец', 'Ветеран', 'Мастер', 'Грандмастер', 'Легенда Монолита'];

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
      <span className="inline-flex items-center gap-1 tabular-nums font-medium">
        <MltCoin size={14} title={currencyName} />
        {num(value)} {currencyName}
      </span>
    </div>
  );
}

type SortKey = 'name' | 'department' | 'eball' | 'rub' | 'earned30' | 'spent30';
type SortState = { key: SortKey; dir: 'desc' | 'asc' };

type XpSortKey = 'name' | 'department' | 'level' | 'title' | 'totalXp' | 'xp30' | 'topClass';
type XpSortState = { key: XpSortKey; dir: 'desc' | 'asc' };

function SortableTh<K extends string>({ label, sortKey, sort, onSort, left, title }: {
  label: string; sortKey: K; sort: { key: K; dir: 'desc' | 'asc' }; onSort: (key: K) => void; left?: boolean; title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      title={title ?? 'Сортировать по колонке'}
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

  const [xpSort, setXpSort] = useState<XpSortState>({ key: 'totalXp', dir: 'desc' });
  const onXpSort = (key: XpSortKey) => setXpSort(s => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  const rows = data?.balances ?? [];
  const sortedRows = useMemo(() => {
    const mult = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      if (sort.key === 'name') return mult * a.name.localeCompare(b.name, 'ru');
      if (sort.key === 'department') return mult * (a.department ?? '').localeCompare(b.department ?? '', 'ru');
      return mult * (Number(a[sort.key]) - Number(b[sort.key]));
    });
  }, [rows, sort]);

  const xpRows = data?.xp.rows ?? [];
  const sortedXpRows = useMemo(() => {
    const mult = xpSort.dir === 'desc' ? -1 : 1;
    return [...xpRows].sort((a, b) => {
      if (xpSort.key === 'name') return mult * a.name.localeCompare(b.name, 'ru');
      if (xpSort.key === 'department') return mult * (a.department ?? '').localeCompare(b.department ?? '', 'ru');
      if (xpSort.key === 'title') return mult * a.title.localeCompare(b.title, 'ru');
      if (xpSort.key === 'topClass') return mult * (a.topClass?.name ?? '').localeCompare(b.topClass?.name ?? '', 'ru');
      return mult * (Number(a[xpSort.key]) - Number(b[xpSort.key]));
    });
  }, [xpRows, xpSort]);

  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>;
  if (isError || !data) return <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить дашборд.</p>;

  const { currencyName, emission, absorption, health, circulation, emissionMomPct, xp, rubEconomics: rub } = data;
  const freeSinkPct = health.freeSinkShare === null ? null : Math.round(health.freeSinkShare * 1000) / 10;
  const freeSinkOk = freeSinkPct !== null && freeSinkPct >= 25 && freeSinkPct <= 35;
  const netFlow = health.emission - health.absorption;

  const rubFmt = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Рублёвая смета (правка владельца 05.08): «сколько потрачено, сколько
             за текущий месяц, сколько в эквиваленте на руках». Три РАЗНЫЕ вещи
             намеренно разведены: обязательство ≠ выдано ≠ реально оплачено. ── */}
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">💰 Сколько это стоит в рублях</h2>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            по курсу {rub.rate.toLocaleString('ru-RU')} ₽ за 1 {currencyName} (Настройки → Награды)
          </span>
        </div>
        {/* Счётчик бюджета (запрос владельца 06.08): сколько из месячного потолка
            уже «напечатано» эмиссией и куда идём по текущему темпу. Сравниваем
            именно с эмиссией: каждый начисленный балл — обещание, за которым
            рано или поздно придут. */}
        {(() => {
          const used = rub.budgetUsedRub, plan = rub.budgetRub, fc = rub.budgetForecastRub;
          const pct = plan > 0 ? Math.round((used / plan) * 100) : 0;
          const fcPct = plan > 0 ? Math.round((fc / plan) * 100) : 0;
          const color = fcPct > 100 ? 'var(--color-negative)' : fcPct > 85 ? '#e8590c' : 'var(--color-positive)';
          return (
            <div className="mb-3 rounded-xl border px-3.5 py-3" style={{ borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[13px] font-bold text-[var(--color-text)]">Эмиссия месяца против потолка</span>
                <span className="text-[13px] tabular-nums" style={{ color }}>
                  {rubFmt(used)} из {rubFmt(plan)} · {pct}%
                </span>
                <span className="ml-auto text-[12px] tabular-nums text-[var(--color-text-muted)]">
                  прогноз до конца месяца: <b style={{ color }}>{rubFmt(fc)}</b> ({fcPct}%)
                </span>
                {/* Потолок задан по ЭМИССИИ (решение владельца 06.08). Живыми
                    деньгами компания заплатит меньше: около трети уходит в
                    нематериальное (отгулы, обучение) и денег не стоит. */}
                <span className="w-full text-[11px] text-[var(--color-text-muted)]">
                  живыми деньгами из этого ≈ {rubFmt(used * 2 / 3)} (треть уходит в отгулы, обучение и прочее нематериальное)
                </span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[var(--color-bg-hover)]">
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
              </div>
              {fcPct > 100 && (
                <div className="mt-1.5 text-[11px]" style={{ color }}>
                  Идём с перерасходом на {rubFmt(fc - plan)} — стоит подрезать самые массовые награды либо поднять потолок.
                </div>
              )}
            </div>
          );
        })()}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Реально потрачено</div>
            <div className="text-2xl font-extrabold tabular-nums text-[var(--color-negative)]">{rubFmt(rub.spentTotalRub)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              призы {rubFmt(rub.spentMaterialRub)} · выплаты в ЗП {rubFmt(rub.spentPayoutRub)}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">На руках у сотрудников</div>
            <div className="text-2xl font-extrabold tabular-nums text-[var(--color-text)]">{rubFmt(rub.onHandRub)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              {num(rub.onHandMlt)} {currencyName} — обязательство, не трата
            </div>
          </div>
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Начислено за месяц</div>
            <div className="text-2xl font-extrabold tabular-nums text-[var(--color-text)]">{rubFmt(rub.emittedMonthRub)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              за всё время {rubFmt(rub.emittedAllRub)}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Куплено, но не выдано</div>
            <div className="text-2xl font-extrabold tabular-nums text-[var(--color-text)]">{rubFmt(rub.pendingRub)}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
              лежит в инвентарях · привилегии {rubFmt(rub.immaterialRub)}
            </div>
          </div>
        </div>
        <p className="mt-2.5 text-[11px] text-[var(--color-text-muted)] max-w-[92ch]">
          «Реально потрачено» — деньги, которые компания отдала: выданные материальные призы и выплаты
          рублёвого кошелька. Отгулы и прочие привилегии показаны отдельно: это рабочее время, а не деньги.
          Материальные считаются по цене продажи в {currencyName} — оценка сверху; станет точной, когда у
          товаров появится себестоимость в рублях.
        </p>
      </div>

      {/* Агрегаты в обращении */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card title={`Всего в обращении, ${currencyName}`}>
          <div className="flex items-center gap-2 text-2xl font-semibold tabular-nums">
            <MltCoin variant="full" size={28} title={currencyName} />
            {num(circulation.totalEball)}
          </div>
        </Card>
        <Card title="Всего в обращении, ₽">
          <div className="text-2xl font-semibold tabular-nums">{num(circulation.totalRub)}</div>
        </Card>
        <Card title="Эмиссия за месяц">
          <div className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
            <MltCoin size={20} title={currencyName} />
            {num(emission.total)}
          </div>
          {emissionMomPct !== null && (
            <div className={`text-xs mt-1 ${emissionMomPct >= 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
              {emissionMomPct >= 0 ? '▲' : '▼'} {Math.abs(emissionMomPct)}% к пред. месяцу
            </div>
          )}
        </Card>
        <Card title="Поглощение за месяц">
          <div className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums">
            <MltCoin size={20} title={currencyName} />
            {num(health.absorption)}
          </div>
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
            <div className="flex items-center gap-1.5 text-xl font-semibold tabular-nums">
              <MltCoin size={18} title={currencyName} />
              {num(health.toBurn30d)} {currencyName}
            </div>
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
                    <td className="px-3 py-2 text-right tabular-nums">
                      <span className="inline-flex items-center justify-end gap-1"><MltCoin size={14} title={currencyName} />{num(r.eball)}</span>
                    </td>
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

      {/* По опыту (XP) — задача 2745, продолжение дашборда */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card title="Суммарный XP компании">
          <div className="text-2xl font-semibold tabular-nums">{num(xp.summary.totalXp)}</div>
        </Card>
        <Card title="Начислено XP за месяц">
          <div className="text-2xl font-semibold tabular-nums">{num(xp.summary.monthXp)}</div>
        </Card>
        <Card title="Медианный уровень">
          <div className="text-2xl font-semibold tabular-nums">{xp.summary.medianLevel}</div>
        </Card>
        <Card title="Топ-уровень">
          <div className="text-2xl font-semibold tabular-nums">{xp.summary.topLevel}</div>
        </Card>
      </div>

      <Card title="Распределение по титулам">
        <div className="flex flex-wrap gap-4">
          {TITLE_ORDER.map(t => (
            <div key={t} className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold tabular-nums">{xp.summary.titleCounts[t] ?? 0}</span>
              <span className="text-xs text-[var(--color-text-muted)]">{t}</span>
            </div>
          ))}
        </div>
      </Card>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-muted)]">По опыту (XP)</h3>
        {xpRows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Пока нет данных по XP-леджеру.</p>
        ) : (
          <div className="scroll-x rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[var(--color-table-header)]">
                  <SortableTh label="Сотрудник" sortKey="name" sort={xpSort} onSort={onXpSort} left />
                  <SortableTh label="Отдел" sortKey="department" sort={xpSort} onSort={onXpSort} left />
                  <SortableTh label="Уровень" sortKey="level" sort={xpSort} onSort={onXpSort} />
                  <SortableTh label="Титул" sortKey="title" sort={xpSort} onSort={onXpSort} left />
                  <SortableTh label="Всего XP" sortKey="totalXp" sort={xpSort} onSort={onXpSort} />
                  <SortableTh label="XP за 30д" sortKey="xp30" sort={xpSort} onSort={onXpSort} title="Только по датам сделок (sold/ship) — квестовый бонус в 30-дневную дельту не входит, дата события не хранится · сортировать" />
                  <SortableTh label="Топ-класс" sortKey="topClass" sort={xpSort} onSort={onXpSort} left />
                </tr>
              </thead>
              <tbody>
                {sortedXpRows.map((r, i) => (
                  <tr
                    key={r.bitrixId}
                    className={`border-t border-[var(--color-border)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap font-medium">{r.name}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{r.department ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.level}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.title}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{num(r.totalXp)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--color-positive)]">{num(r.xp30)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-[var(--color-text-muted)]">
                      {r.topClass ? `${r.topClass.name} (ур. ${r.topClass.level})` : '—'}
                    </td>
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
