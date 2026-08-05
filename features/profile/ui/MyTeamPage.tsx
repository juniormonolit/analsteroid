'use client';

// «Мой отдел» — `/profile/team` (задача 3045, §3). Экран существовал и раньше, но
// ТОЛЬКО как вкладка внутри `/profile` и только для РОП/Директора/Администратора,
// причём ссылки на него не было ни в меню, ни в «Ещё» — отсюда жалоба «не находится».
//
// Два вида, и выбирает между ними СЕРВЕР (`app/(app)/profile/team/page.tsx` считает
// `canViewDepartmentData` из lib/org/managerAccess.ts и передаёт `canLead`):
//   • руководитель — сводка «Подконтрольные отделы» (план/факт) + ФИФА-сетка
//     подчинённых с мини-радаром, клик ведёт на `/manager/[id]` (перенос, код тот же);
//   • рядовой менеджер — сетка КОЛЛЕГ своего отдела: имя, фото, место в рейтинге,
//     % выполнения личного плана. Без абсолютных сумм и без перехода на чужую карточку
//     (`canViewManager` и так запретит, но и ссылки нет — тупика не создаём).
//
// Роль-гейт по ИМЕНИ роли (прежний `ROSTER_ROLES`) здесь не используется намеренно:
// переименование роли в справочнике не должно отбирать людям доступ (требование §3).

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { useUrlState, enumParam } from '@/lib/hooks/useUrlState';
import { DeptRosterGrid } from './DeptRosterGrid';
import type { PeerRosterResult } from '@/features/profile/engine/peerRoster';

interface DeptSummary {
  month: string; // YYYY-MM-01
  workingDays: { inMonth: number; passed: number };
  departments: {
    departmentId: string;
    name: string;
    planShipments: number;
    factShipments: number;
    pctPlan: number | null;
    pctPace: number | null;
  }[];
  total: { planShipments: number; factShipments: number; pctPlan: number | null; pctPace: number | null };
}

const cardCls = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5';

function fmtMoney(v: number): string {
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}

function pctClass(v: number | null): string {
  if (v === null) return 'text-[var(--color-text-muted)]';
  if (v >= 100) return 'text-green-600';
  if (v >= 80) return 'text-[var(--color-text)]';
  return 'text-red-500';
}

const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function monthTitle(month: string): string {
  const [y, m] = month.split('-');
  const name = MONTH_NAMES[parseInt(m, 10) - 1] ?? '';
  return `${name} ${y}`;
}

export function MyTeamPage({ canLead }: { canLead: boolean }) {
  return (
    <div className="p-3 sm:p-6 md:mx-auto md:w-[var(--content-col)] flex flex-col gap-4">
      {canLead ? <LeadView /> : <PeerView />}
    </div>
  );
}

// ── Вид руководителя (перенос из вкладки профиля, логика не менялась) ─────────
function LeadView() {
  const { data: summary, isLoading: summaryLoading } = useQuery<DeptSummary>({
    queryKey: ['me-dept-summary'],
    queryFn: async () => {
      const res = await fetch('/api/me/dept-summary');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  // Отделы назначены или нет — видно по самой сводке: пустой список отделов и есть
  // ответ «назначений нет». Отдельный запрос /api/me ради этого больше не нужен
  // (раньше признак брался из него, потому что компонент жил внутри страницы профиля).
  const hasDepartments = (summary?.departments.length ?? 0) > 0;
  const meLoading = false;

  return (
    <>
      {/* Подконтрольные отделы (план/факт) — под вкладкой «Мой отдел» вместе
          с сеткой: обе части — «живая аналитика», не настройки. */}
      <div className={cardCls}>
        <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Подконтрольные отделы</h2>
          {summary && hasDepartments && (
            <span className="text-xs text-[var(--color-text-muted)]">
              Отгрузки, {monthTitle(summary.month)} (МСК) · раб. дней: {summary.workingDays.passed} из {summary.workingDays.inMonth}
            </span>
          )}
        </div>

        {meLoading || (hasDepartments && summaryLoading) ? (
          <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
        ) : !hasDepartments ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            Отделы не назначены. Обратитесь к администратору.
          </p>
        ) : summary ? (
          <div className="scroll-x -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                  <th className="py-2 pr-3 font-medium">Отдел</th>
                  <th className="py-2 px-3 font-medium text-right">План</th>
                  <th className="py-2 px-3 font-medium text-right">Факт</th>
                  <th className="py-2 px-3 font-medium text-right">% план</th>
                  <th className="py-2 pl-3 font-medium text-right">% темп</th>
                </tr>
              </thead>
              <tbody>
                {summary.departments.map((d) => (
                  <tr key={d.departmentId} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2 pr-3 text-[var(--color-text)]">{d.name}</td>
                    <td className="py-2 px-3 text-right text-[var(--color-text-muted)] whitespace-nowrap">{fmtMoney(d.planShipments)}</td>
                    <td className="py-2 px-3 text-right text-[var(--color-text)] whitespace-nowrap">{fmtMoney(d.factShipments)}</td>
                    <td className={`py-2 px-3 text-right whitespace-nowrap ${pctClass(d.pctPlan)}`}>{fmtPct(d.pctPlan)}</td>
                    <td className={`py-2 pl-3 text-right whitespace-nowrap ${pctClass(d.pctPace)}`}>{fmtPct(d.pctPace)}</td>
                  </tr>
                ))}
                {summary.departments.length > 1 && (
                  <tr className="font-medium">
                    <td className="py-2 pr-3 text-[var(--color-text)]">Итого</td>
                    <td className="py-2 px-3 text-right text-[var(--color-text-muted)] whitespace-nowrap">{fmtMoney(summary.total.planShipments)}</td>
                    <td className="py-2 px-3 text-right text-[var(--color-text)] whitespace-nowrap">{fmtMoney(summary.total.factShipments)}</td>
                    <td className={`py-2 px-3 text-right whitespace-nowrap ${pctClass(summary.total.pctPlan)}`}>{fmtPct(summary.total.pctPlan)}</td>
                    <td className={`py-2 pl-3 text-right whitespace-nowrap ${pctClass(summary.total.pctPace)}`}>{fmtPct(summary.total.pctPace)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-sm text-red-500">Не удалось собрать сводку</div>
        )}
      </div>

      {/* ФИФА-сетка подчинённых — свой селектор отдела/периода и ссылка
          «Карточка отдела» внутри компонента. */}
      <DeptRosterGrid />
    </>
  );
}

// ── Вид рядового менеджера (новое, §3 спеки) ─────────────────────────────────
function PeerView() {
  // Период — в адресе (replace: это донастройка взгляда, а не шаг истории).
  // 'month'/'all' вместо ?from&to из спеки: соседняя сетка руководителя
  // (DeptRosterGrid) уже показывает ровно этот переключатель, и заводить рядом
  // второй, другой по смыслу способ выбора периода — верный путь к вопросу
  // «почему у нас два разных периода в одном экране».
  const [period, setPeriod] = useUrlState('period', enumParam(['month', 'all'] as const, 'month'));

  const { data, isLoading, isError } = useQuery<PeerRosterResult>({
    queryKey: ['team-roster', period],
    queryFn: async () => {
      const res = await fetch(`/api/team/roster?period=${period}`);
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
    staleTime: 60_000,
  });

  return (
    <div className={cardCls}>
      <div className="flex items-baseline justify-between gap-2 mb-1 flex-wrap">
        <h2 className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-2">
          <Users size={15} className="text-[var(--color-text-muted)]" />
          {data?.departmentName ?? 'Мой отдел'}
        </h2>
        <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
          {([['month', 'Месяц'], ['all', 'Всё время']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`px-3 py-1 transition-colors ${
                period === key
                  ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                  : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        Коллеги отдела: место в рейтинге и выполнение личного плана продаж. Суммы сделок
        коллег не показываются.
      </p>

      {isLoading ? (
        <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
      ) : isError ? (
        <div className="text-sm text-red-500">Не удалось загрузить отдел</div>
      ) : !data || data.peers.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Отдел не определён в оргструктуре — обратитесь к администратору.
        </p>
      ) : (
        <div className="scroll-x -mx-4 sm:mx-0 px-4 sm:px-0">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                <th className="py-2 pr-3 font-medium w-10">#</th>
                <th className="py-2 pr-3 font-medium">Менеджер</th>
                <th className="py-2 pl-3 font-medium text-right whitespace-nowrap">% плана</th>
              </tr>
            </thead>
            <tbody>
              {data.peers.map(p => (
                <tr
                  key={p.managerId}
                  className={`border-b border-[var(--color-border)] last:border-0 ${
                    p.isMe ? 'bg-[var(--color-accent-soft)]' : ''
                  }`}
                >
                  <td className="py-2 pr-3 text-[var(--color-text-muted)] tabular-nums">
                    {p.place ?? '—'}
                  </td>
                  <td className="py-2 pr-3">
                    {/* Имя → публичный профиль коллеги (ЛК-соцсетка, 05.08);
                        своя строка ведёт в собственный ЛК (страница /profile/<свой id>
                        сама редиректит на /profile). */}
                    <Link href={`/profile/${p.managerId}`} className="flex items-center gap-2 min-w-0 min-h-11 -my-2 py-2 hover:opacity-80 transition-opacity">
                      <Avatar name={p.name} url={p.avatarUrl} size={28} />
                      <span className={`truncate ${p.isMe ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]'}`}>
                        {p.name}{p.isMe && ' — вы'}
                      </span>
                    </Link>
                  </td>
                  <td className={`py-2 pl-3 text-right whitespace-nowrap tabular-nums ${pctClass(p.planPct)}`}>
                    {p.planPct === null ? '—' : `${p.planPct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
