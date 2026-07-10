'use client';

// ФИФА-сетка «Мой отдел» (карточка менеджера v2, бриф 10.07, п.1) — набор
// карточек-бейджей менеджеров подконтрольного отдела (см. мокап manager-card-mock.html,
// экран 2). Видимость решается родителем (ProfilePage) по роли; здесь — только сама
// сетка + селектор отдела/периода + ссылка «Карточка отдела».

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { startOfMonth } from 'date-fns';
import { ManagerCardPanel } from '@/features/manager-card/ui/ManagerCardPanel';
import type { CardSegment } from '@/features/manager-card/engine/managerCard';
import type { DateRange } from '@/lib/period';

interface TeamManager {
  managerId: string;
  name: string;
  login: string | null;
  rating: number | null;
  radar: number[];
  salesAmount: number;
  crOverall: number | null;
  isTop1: boolean;
}

interface TeamResponse {
  departmentOptions: { id: string; name: string }[];
  selectedDepartmentId: string | null;
  departmentName: string | null;
  managers: TeamManager[];
  totalManagers: number;
}

type PeriodChoice = 'month' | 'all';
const ALL_TIME_RANGE: DateRange = { from: new Date('2015-01-01T00:00:00Z'), to: new Date() };

function fmtMoney(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Мини-радар без подписей (мокап: .mgr-radar) — 6 осей, только слой периода. */
function MiniRadar({ values }: { values: number[] }) {
  const n = values.length || 1;
  const CX = 45, CY = 45, R = 29;
  const angle = (i: number) => (-90 + i * (360 / n)) * (Math.PI / 180);
  const pt = (i: number, v: number) => {
    const rr = R * (Math.max(0, Math.min(10, v)) / 10);
    const a = angle(i);
    return { x: CX + rr * Math.cos(a), y: CY + rr * Math.sin(a) };
  };
  const ring = Array.from({ length: n }, (_, i) => pt(i, 10));
  const poly = values.map((v, i) => pt(i, v));
  const toPath = (pts: { x: number; y: number }[]) => pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return (
    <svg width={90} height={84} viewBox="0 0 90 84">
      <polygon points={toPath(ring)} fill="none" stroke="var(--color-border)" strokeWidth={1} />
      <polygon points={toPath(poly)} fill="var(--color-accent)" fillOpacity={0.26} stroke="var(--color-accent)" strokeWidth={1.6} />
    </svg>
  );
}

export function DeptRosterGrid() {
  const [periodChoice, setPeriodChoice] = useState<PeriodChoice>('month');
  const [segment, setSegment] = useState<CardSegment>('all');
  const [departmentId, setDepartmentId] = useState<string | undefined>(undefined);
  const [openManagerId, setOpenManagerId] = useState<{ id: string; name?: string } | null>(null);
  const [showDeptCard, setShowDeptCard] = useState(false);

  const period: DateRange = useMemo(() => {
    if (periodChoice === 'all') return ALL_TIME_RANGE;
    return { from: startOfMonth(new Date()), to: new Date() };
  }, [periodChoice]);
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();

  const { data, isLoading, error } = useQuery<TeamResponse>({
    queryKey: ['manager-card-team', departmentId ?? 'default', fromIso, toIso, segment],
    queryFn: async () => {
      const res = await fetch('/api/manager-card/team', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ departmentId, period: { from: fromIso, to: toIso }, segment }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Не удалось загрузить сетку отдела');
      return res.json();
    },
    staleTime: 60_000,
  });

  const cardCls = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5';

  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Мой отдел</h2>
          {data && (
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {data.totalManagers} менеджеров · {data.departmentName ?? '—'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(data?.departmentOptions.length ?? 0) > 1 && (
            <select
              value={departmentId ?? data?.selectedDepartmentId ?? 'all'}
              onChange={e => setDepartmentId(e.target.value)}
              className="text-xs border border-[var(--color-border)] rounded-lg px-2 py-1.5 bg-[var(--color-bg-surface)] text-[var(--color-text)]"
            >
              <option value="all">Все отделы</option>
              {data?.departmentOptions.map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
          <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
            {(['month', 'all'] as PeriodChoice[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriodChoice(p)}
                className={`px-2.5 py-1.5 transition-colors ${periodChoice === p ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
              >
                {p === 'month' ? 'Этот месяц' : 'Всё время'}
              </button>
            ))}
          </div>
          <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
            {([{ k: 'all', l: 'Все' }, { k: 'fl', l: 'Физики' }, { k: 'ul', l: 'Юрики' }] as { k: CardSegment; l: string }[]).map(opt => (
              <button
                key={opt.k}
                onClick={() => setSegment(opt.k)}
                className={`px-2.5 py-1.5 transition-colors ${segment === opt.k ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
              >
                {opt.l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data?.selectedDepartmentId && (
        <button
          onClick={() => setShowDeptCard(true)}
          className="w-full flex items-center gap-2 mb-4 rounded-xl px-4 py-2.5 text-xs text-[var(--color-text-muted)]"
          style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 8%, transparent)' }}
        >
          <span className="flex-1 text-left">
            У отдела есть своя большая карточка — та же форма (шапка · паутина · плитки), посчитанная агрегатом по всем менеджерам.
          </span>
          <span className="font-bold text-[var(--color-accent)] whitespace-nowrap">Открыть карточку отдела →</span>
        </button>
      )}

      {error ? (
        <div className="text-sm text-red-500">{error instanceof Error ? error.message : 'Ошибка загрузки'}</div>
      ) : isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-40 bg-[var(--color-border)] rounded-2xl animate-pulse" />)}
        </div>
      ) : (data?.managers.length ?? 0) === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Отделы не назначены. Обратитесь к администратору.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {data!.managers.map(m => (
            <button
              key={m.managerId}
              onClick={() => setOpenManagerId({ id: m.managerId, name: m.name })}
              className={`relative flex flex-col items-center text-center gap-0.5 bg-[var(--color-bg-surface)] border rounded-2xl px-3.5 py-4 hover:border-[var(--color-border-focus)] transition-colors ${
                m.isTop1 ? 'border-2' : 'border-[var(--color-border)]'
              }`}
              style={m.isTop1 ? { borderColor: 'var(--color-top1-border)', boxShadow: '0 0 0 4px var(--color-top1-glow)' } : undefined}
            >
              <span
                className="absolute top-2.5 right-2.5 text-[13px] font-extrabold rounded-lg px-2 py-0.5"
                style={m.isTop1
                  ? { backgroundColor: 'var(--color-top1-bg)', color: 'var(--color-top1-text)' }
                  : { backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)', color: 'var(--color-accent)' }}
              >
                {m.rating !== null ? m.rating.toFixed(1) : '—'}
              </span>
              <div
                className="w-11 h-11 rounded-full flex items-center justify-center text-[15px] font-extrabold mb-1.5"
                style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 16%, transparent)', color: 'var(--color-accent)' }}
              >
                {initials(m.name)}
              </div>
              <div className="text-[13px] font-bold text-[var(--color-text)] leading-tight">{m.name}</div>
              {m.login && <div className="text-[11px] text-[var(--color-text-muted)] mb-0.5">{m.login}</div>}
              <MiniRadar values={m.radar} />
              <div className="flex flex-col gap-0.5 text-[11.5px] text-[var(--color-text-muted)] border-t border-[var(--color-border)] pt-2 mt-1 w-full">
                <span>Продажи <b className="text-[var(--color-text)]">{fmtMoney(m.salesAmount)}</b></span>
                <span>CR <b className="text-[var(--color-text)]">{m.crOverall !== null ? `${m.crOverall.toFixed(0)}%` : '—'}</b></span>
              </div>
            </button>
          ))}
        </div>
      )}

      {openManagerId && (
        <ManagerCardPanel
          key={openManagerId.id}
          managerId={openManagerId.id}
          managerName={openManagerId.name}
          reportPeriod={period}
          onClose={() => setOpenManagerId(null)}
        />
      )}
      {showDeptCard && data?.selectedDepartmentId && (
        <ManagerCardPanel
          key={`dept-${data.selectedDepartmentId}`}
          managerId={data.selectedDepartmentId}
          managerName={data.departmentName ?? undefined}
          reportPeriod={period}
          mode="department"
          onClose={() => setShowDeptCard(false)}
        />
      )}
    </div>
  );
}
