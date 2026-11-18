'use client';

// Таймлайн логинов (раздел «Сотрудники», решение владельца 18.11): слева логины
// Битрикса, сгруппированные по отделам; справа по месяцам — полосы «ФИО на логине
// с–по» (sa.employee_tenures). Текущий человек — акцентом, прошлые — приглушённо,
// неизвестная дата найма — полоса с растушёвкой от левого края периода.
// Клик по строке — карточка сотрудника (TenureCardModal).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { TenureCardModal, fmtDate, type LoginDto, type TenureDto } from './TenureCardModal';

const MW = 44; // ширина месяца, px
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

type Period = '12m' | '24m' | '2024' | 'all';
const PERIOD_OPTIONS = [
  { value: '12m', label: 'Последние 12 месяцев' },
  { value: '24m', label: 'Последние 2 года' },
  { value: '2024', label: 'С 2024 года' },
  { value: 'all', label: 'Всё время' },
];
type Show = 'all' | 'no_start' | 'vacant' | 'changed';
const SHOW_OPTIONS = [
  { value: 'all', label: 'Все логины' },
  { value: 'no_start', label: 'Без даты найма' },
  { value: 'vacant', label: 'Свободные (никого нет)' },
  { value: 'changed', label: 'Со сменой людей' },
];

const todayIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

// Индекс месяца от начала диапазона + доля дня — в пикселях.
function makeScale(fromY: number, fromM: number) {
  return (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    const idx = (y - fromY) * 12 + (m - 1 - fromM);
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return (idx + (d - 1) / dim) * MW;
  };
}

export function TimelineView() {
  const [search, setSearch] = useState('');
  const [depts, setDepts] = useState<string[]>([]);
  const [period, setPeriod] = useState<Period>('24m');
  const [show, setShow] = useState<Show>('all');
  const [showInactive, setShowInactive] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [card, setCard] = useState<LoginDto | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery<{ migrated: boolean; canEdit: boolean; logins: LoginDto[]; tenures: TenureDto[] }>({
    queryKey: ['employees-timeline'],
    queryFn: async () => {
      const res = await fetch('/api/employees/timeline');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const today = todayIso();
  const tenuresBy = useMemo(() => {
    const m = new Map<number, TenureDto[]>();
    for (const t of data?.tenures ?? []) {
      if (!m.has(t.bitrixId)) m.set(t.bitrixId, []);
      m.get(t.bitrixId)!.push(t);
    }
    return m;
  }, [data]);

  // Диапазон: от выбранного начала до конца текущего месяца.
  const range = useMemo(() => {
    const [ty, tm] = today.split('-').map(Number);
    let fromY = ty, fromM = tm - 1;
    if (period === '12m') { fromM -= 11; }
    else if (period === '24m') { fromM -= 23; }
    else if (period === '2024') { fromY = 2024; fromM = 0; }
    else {
      const starts = (data?.tenures ?? []).map(t => t.startDate).filter((x): x is string => !!x).sort();
      const first = starts[0] ?? '2024-01-01';
      fromY = Number(first.slice(0, 4)); fromM = Number(first.slice(5, 7)) - 1;
    }
    while (fromM < 0) { fromM += 12; fromY -= 1; }
    const months = (ty - fromY) * 12 + (tm - 1 - fromM) + 1;
    const fromIso = `${fromY}-${String(fromM + 1).padStart(2, '0')}-01`;
    return { fromY, fromM, months, fromIso };
  }, [period, today, data]);
  const x = useMemo(() => makeScale(range.fromY, range.fromM), [range]);
  const width = range.months * MW;
  const todayX = x(today);

  const deptOptions = useMemo(() => {
    const s = new Set((data?.logins ?? []).map(l => l.department ?? 'Без отдела'));
    return [...s].sort((a, b) => a.localeCompare(b, 'ru')).map(d => ({ value: d, label: d }));
  }, [data]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const by = new Map<string, LoginDto[]>();
    for (const l of data?.logins ?? []) {
      if (!showInactive && !l.isActive) continue;
      const dept = l.department ?? 'Без отдела';
      if (depts.length && !depts.includes(dept)) continue;
      const ts = tenuresBy.get(l.bitrixId) ?? [];
      const open = ts.find(t => t.endDate === null);
      if (show === 'no_start' && !(open && !open.startDate)) continue;
      if (show === 'vacant' && open) continue;
      if (show === 'changed' && ts.length < 2) continue;
      if (q && !(l.name.toLowerCase().includes(q) || (l.login ?? '').toLowerCase().includes(q) ||
        String(l.bitrixId).includes(q) || ts.some(t => t.personName.toLowerCase().includes(q)))) continue;
      if (!by.has(dept)) by.set(dept, []);
      by.get(dept)!.push(l);
    }
    return [...by.entries()].sort((a, b) =>
      a[0] === 'Без отдела' ? 1 : b[0] === 'Без отдела' ? -1 : a[0].localeCompare(b[0], 'ru'));
  }, [data, search, depts, show, showInactive, tenuresBy]);
  const shown = groups.reduce((n, [, l]) => n + l.length, 0);

  // Сразу показываем «сегодня» у правого края, а не начало диапазона.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, todayX - el.clientWidth * 0.6);
  }, [todayX, data]);

  const toggle = (d: string) => setCollapsed(p => { const n = new Set(p); if (n.has(d)) n.delete(d); else n.add(d); return n; });

  const months = Array.from({ length: range.months }, (_, i) => {
    const m = (range.fromM + i) % 12;
    const y = range.fromY + Math.floor((range.fromM + i) / 12);
    return { m, y };
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ФИО, логин, ID…"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-1.5 pl-7 pr-2 text-base sm:text-sm"
          />
        </div>
        <SearchMultiSelect options={deptOptions} value={depts} onChange={setDepts} allLabel="Все отделы" unitLabel="отдела" ariaLabel="Отделы" />
        <SearchSelect options={PERIOD_OPTIONS} value={period} onChange={(v) => setPeriod(v as Period)} ariaLabel="Период" />
        <SearchSelect options={SHOW_OPTIONS} value={show} onChange={(v) => setShow(v as Show)} ariaLabel="Показать" />
        <label className="flex min-h-11 sm:min-h-0 items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          отключённые логины
        </label>
        <span className="text-xs text-[var(--color-text-muted)]">{shown} логинов</span>
      </div>

      {isLoading && <div className="p-6 text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {isError && <div className="p-6 text-sm text-red-500">Не удалось загрузить таймлайн</div>}
      {data && !data.migrated && (
        <div className="rounded-lg border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
          Таймлайн появится после наката миграции <code>sa_org/010</code> на прод-базу.
        </div>
      )}

      {data?.migrated && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-5 rounded-sm bg-[var(--color-accent)]" /> сейчас на логине</span>
            <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-5 rounded-sm bg-[color-mix(in_srgb,var(--color-text-muted)_35%,transparent)]" /> раньше</span>
            <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-5 rounded-sm bg-gradient-to-r from-transparent to-[var(--color-accent)]" /> дата найма неизвестна</span>
          </div>
          <div ref={scrollRef} className="scroll-x rounded-lg border border-[var(--color-border)]">
            <div className="min-w-max text-sm">
              {/* Шапка: годы и месяцы */}
              <div className="sticky top-0 z-20 flex border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
                <div className="sticky left-0 z-30 w-36 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-1 text-xs font-medium uppercase text-[var(--color-text-muted)] sm:w-60">
                  Логин
                </div>
                <div className="relative h-10" style={{ width }}>
                  {months.map(({ m, y }, i) => (
                    <div key={i} className="absolute top-0 h-full border-l border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)]" style={{ left: i * MW, width: MW }}>
                      {(m === 0 || i === 0) && <div className="px-1 font-semibold text-[var(--color-text)]">{y}</div>}
                      <div className="absolute bottom-0.5 px-1">{MONTHS[m]}</div>
                    </div>
                  ))}
                </div>
              </div>

              {groups.map(([dept, logins]) => (
                <div key={dept}>
                  <button
                    type="button"
                    onClick={() => toggle(dept)}
                    className="sticky left-0 z-10 flex min-h-9 items-center gap-1 bg-[var(--color-bg)] px-2 text-left text-xs font-semibold"
                  >
                    {collapsed.has(dept) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    {dept} <span className="font-normal text-[var(--color-text-muted)]">· {logins.length}</span>
                  </button>
                  {!collapsed.has(dept) && logins.map(l => (
                    <div key={l.bitrixId} className="group flex border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]">
                      <button
                        type="button"
                        onClick={() => setCard(l)}
                        className="sticky left-0 z-10 w-36 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-left group-hover:bg-[var(--color-bg-hover)] sm:w-60"
                        title="Карточка сотрудника"
                      >
                        <div className={`truncate ${l.isActive ? '' : 'text-[var(--color-text-muted)] line-through'}`}>{l.name}</div>
                        <div className="truncate text-[11px] text-[var(--color-text-muted)]">{l.login ?? '—'} · {l.bitrixId}</div>
                      </button>
                      <div className="relative h-11 cursor-pointer" style={{ width }} onClick={() => setCard(l)}>
                        <div className="absolute top-0 h-full w-px bg-[var(--color-accent)] opacity-40" style={{ left: todayX }} />
                        {(tenuresBy.get(l.bitrixId) ?? []).map(t => {
                          const end = t.endDate ?? today;
                          if (end < range.fromIso) return null;
                          const unknown = !t.startDate;
                          const left = unknown ? 0 : Math.max(0, x(t.startDate! < range.fromIso ? range.fromIso : t.startDate!));
                          const w = Math.max(4, Math.min(width, x(end) + MW / 30) - left);
                          const current = t.endDate === null;
                          const bg = current
                            ? (unknown ? 'bg-gradient-to-r from-transparent to-[var(--color-accent)] to-[40px]' : 'bg-[var(--color-accent)]')
                            : (unknown ? 'bg-gradient-to-r from-transparent to-[color-mix(in_srgb,var(--color-text-muted)_35%,transparent)] to-[40px]' : 'bg-[color-mix(in_srgb,var(--color-text-muted)_35%,transparent)]');
                          return (
                            <div
                              key={t.id}
                              className={`absolute top-2 flex h-7 items-center overflow-hidden rounded px-1.5 text-xs ${bg} ${current ? 'text-[var(--color-text-inverse)]' : 'text-[var(--color-text)]'}`}
                              style={{ left, width: w }}
                              title={`${t.personName}: ${t.startDate ? fmtDate(t.startDate) : '?'} — ${t.endDate ? fmtDate(t.endDate) : 'сейчас'}${t.position ? ` · ${t.position}` : ''}`}
                            >
                              <span className={`truncate ${unknown ? 'pl-6' : ''}`}>{t.personName}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {groups.length === 0 && <div className="p-6 text-sm text-[var(--color-text-muted)]">Никого под выбранные фильтры</div>}
            </div>
          </div>
        </>
      )}

      <TenureCardModal login={card} onClose={() => setCard(null)} />
    </div>
  );
}
