'use client';
// Табы ЛК менеджера (доп. Серёги 31.07): «Профиль» (сводка) · «Статистика»
// (прежняя детальная карточка) · «Награды» (полка + история начислений) ·
// «Магазин» (заглушка — механику Серёга обсудит отдельно). Дефолт — «Профиль».
// Только mode='manager': у агрегата отдела нет одной личности/полки/баланса,
// там прежняя структура (полка РОПа + «Моя команда» — не теряются).

import { useQuery } from '@tanstack/react-query';
import { Avatar } from '@/components/ui/Avatar';
import { BadgeCard, BadgeShelf, useShelfQuery } from '@/features/badges/ui/BadgeShelf';
import { TIER_LABELS, type BadgeTier } from '@/features/badges/engine/catalog';
import { usePlanFact } from './PlanFactStrip';
import type { ManagerCardResult } from '@/features/manager-card/engine/managerCard';

export type ManagerTabKey = 'profile' | 'stats' | 'rewards' | 'shop';

export const MANAGER_TABS: { key: ManagerTabKey; label: string }[] = [
  { key: 'profile', label: 'Профиль' },
  { key: 'stats', label: 'Статистика' },
  { key: 'rewards', label: 'Награды' },
  { key: 'shop', label: 'Магазин' },
];

export function ManagerTabBar({ active, onChange }: { active: ManagerTabKey; onChange: (t: ManagerTabKey) => void }) {
  return (
    // Узкий вьюпорт (Битрикс-iframe): горизонтальный скролл вместо развала сетки.
    <div className="flex gap-1 overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1">
      {MANAGER_TABS.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`flex-1 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
            active === t.key
              ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
              : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── общие данные табов ───────────────────────────────────────────────────────

interface LedgerRow { date: string; badge_name: string; icon: string | null; tier: string | null; amount: number }
interface ProfileExtra { tenure: { startDate: string; label: string | null } | null; ledger: LedgerRow[] }

// Стаж + история начислений: своё (isSelf) — без параметра, чужое — по bitrixId
// (второй рубеж canViewManager в самом роуте).
export function useProfileExtra(managerId: string, isSelf: boolean) {
  return useQuery<ProfileExtra>({
    queryKey: ['badges-profile-extra', isSelf ? 'me' : managerId],
    queryFn: async () => {
      const qs = isSelf ? '' : `?bitrixId=${encodeURIComponent(managerId)}`;
      const res = await fetch(`/api/badges/profile${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

function BalancePill({ balance, currencyName, big = false }: { balance: number; currencyName: string; big?: boolean }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 rounded-2xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 ${big ? 'px-5 py-2.5' : 'px-3 py-1'}`}>
      <span className={`font-extrabold tabular-nums text-[var(--color-accent)] ${big ? 'text-3xl' : 'text-xl'}`}>{balance.toLocaleString('ru-RU')}</span>
      <span className={`font-semibold text-[var(--color-text-muted)] ${big ? 'text-sm' : 'text-xs'}`}>{currencyName}</span>
    </span>
  );
}

// ── Таб «Профиль»: сводка ────────────────────────────────────────────────────

export function ProfileTab({ managerId, isSelf, card, onGoRewards }: {
  managerId: string;
  isSelf: boolean;
  card: ManagerCardResult | undefined;
  onGoRewards: () => void;
}) {
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  const { data: extra } = useProfileExtra(managerId, isSelf);
  const { data: planFact } = usePlanFact(managerId, 'manager');

  const shelf = shelfData?.shelf ?? [];
  const recent = shelf.slice(0, 4);
  const month = planFact?.month;
  const planPct = month && month.planSales && month.planSales > 0
    ? Math.round((month.salesAmount / month.planSales) * 100) : null;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Сводка: кто + стаж + баланс + место в рейтинге */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-5">
        <div className="flex items-center gap-4 flex-wrap">
          <Avatar name={card?.profile.name ?? '?'} url={card?.profile.avatarUrl} size={72} />
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-extrabold text-[var(--color-text)] truncate">{card?.profile.name ?? '…'}</h2>
            <div className="mt-1 text-[13px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap">
              {card?.profile.department && <span>{card.profile.department}</span>}
              {card?.profile.department && card?.profile.branch && <span>·</span>}
              {card?.profile.branch && <span>{card.profile.branch}</span>}
            </div>
            <div className="mt-1 text-[13px] text-[var(--color-text-muted)]">
              Стаж: <b className="text-[var(--color-text)]">{extra?.tenure?.label ?? '—'}</b>
              {extra?.tenure?.startDate && (
                <span className="ml-1">(с {extra.tenure.startDate.split('-').reverse().join('.')})</span>
              )}
            </div>
          </div>
          <BalancePill balance={shelfData?.balance ?? 0} currencyName={shelfData?.currencyName ?? 'ебаллы'} big />
        </div>
        {/* Место в рейтинге — те же ранги, что в hero «Статистики» (общий запрос карточки) */}
        {(card?.ranks?.length ?? 0) > 0 && (
          <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex items-center gap-4 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Место в рейтинге</span>
            {card!.ranks!.map(r => (
              <span key={r.key} className="text-[13px] whitespace-nowrap">
                <b className="text-[var(--color-accent)]">{r.rank ? `#${r.rank}` : '—'}</b>
                <span className="text-[var(--color-text-muted)]"> из {r.size} {r.label}</span>
              </span>
            ))}
            {card?.rating.value != null && (
              <span className="text-[13px] whitespace-nowrap">
                <span className="text-[var(--color-text-muted)]">рейтинг </span>
                <b className="text-[var(--color-text)]">{card.rating.value.toFixed(1)}</b>
              </span>
            )}
          </div>
        )}
      </section>

      {/* Ключевые цифры текущего месяца (тот же plan-fact, что «Статистика») */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
          Текущий месяц{month ? ` · с ${month.fromStr.split('-').reverse().slice(0, 2).join('.')}` : ''}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Продажи</div>
            <div className="text-xl font-extrabold text-[var(--color-text)] whitespace-nowrap">{fmtMoney(month?.salesAmount)}</div>
            {month?.planSales != null && month.planSales > 0 && (
              <div className="mt-1">
                <div className="text-[11px] text-[var(--color-text-muted)]">план {fmtMoney(month.planSales)}{planPct !== null ? ` · ${planPct}%` : ''}</div>
                <div className="h-1.5 mt-1 rounded-full bg-[var(--color-border)] overflow-hidden">
                  <div className="h-full rounded-full" style={{
                    width: `${Math.min(100, (month.salesAmount / month.planSales) * 100)}%`,
                    backgroundColor: month.salesAmount >= month.planSales ? 'var(--color-positive, #2f9e44)' : 'var(--color-accent)',
                  }} />
                </div>
              </div>
            )}
          </div>
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Кол-во продаж</div>
            <div className="text-xl font-extrabold text-[var(--color-text)]">{month?.salesCount ?? '—'}</div>
          </div>
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Отгружено</div>
            <div className="text-xl font-extrabold text-[var(--color-text)] whitespace-nowrap">{fmtMoney(month?.shipmentsAmount)}</div>
          </div>
          <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">Брони</div>
            <div className="text-xl font-extrabold text-[var(--color-text)]">{month?.reservationsCount ?? '—'}</div>
          </div>
        </div>
      </section>

      {/* Последние награды */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Последние награды</div>
          {shelf.length > 0 && (
            <button type="button" onClick={onGoRewards} className="text-xs font-semibold text-[var(--color-accent)] hover:underline">
              Все награды ({shelf.length}) →
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">Наград пока нет — всё впереди!</div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {recent.map(item => <BadgeCard key={item.key} item={item} />)}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Таб «Награды»: полная полка + история начислений ─────────────────────────

export function RewardsTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  const { data: extra, isLoading } = useProfileExtra(managerId, isSelf);
  const currencyName = shelfData?.currencyName ?? 'ебаллы';
  const ledger = extra?.ledger ?? [];

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <BadgeShelf managerId={isSelf ? undefined : managerId} />
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">История начислений</h2>
          {ledger.length > 0 && <span className="text-xs text-[var(--color-text-muted)]">{ledger.length}</span>}
        </div>
        {isLoading ? (
          <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>
        ) : ledger.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">Начислений пока нет.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  <th className="py-1.5 pr-3 font-bold">Дата</th>
                  <th className="py-1.5 pr-3 font-bold">Награда</th>
                  <th className="py-1.5 text-right font-bold">{currencyName}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r, i) => (
                  <tr key={i} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">
                      {r.date.split('-').reverse().join('.')}
                    </td>
                    <td className="py-1.5 pr-3">
                      {r.icon && <span className="mr-1.5">{r.icon}</span>}
                      <span className="text-[var(--color-text)]">{r.badge_name}</span>
                      {r.tier && (
                        <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">
                          {TIER_LABELS[r.tier as BadgeTier] ?? r.tier}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right font-semibold tabular-nums text-[var(--color-accent)]">+{r.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Таб «Магазин»: заглушка (механику Серёга обсудит отдельно) ───────────────

export function ShopTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-10 flex flex-col items-center gap-4 text-center">
      <span className="text-4xl">🛍️</span>
      <BalancePill balance={shelfData?.balance ?? 0} currencyName={shelfData?.currencyName ?? 'ебаллы'} big />
      <div>
        <div className="text-base font-bold text-[var(--color-text)]">Магазин призов скоро откроется</div>
        <div className="mt-1 text-sm text-[var(--color-text-muted)]">
          Копите {shelfData?.currencyName ?? 'ебаллы'} за награды — здесь их можно будет обменять на призы.
        </div>
      </div>
    </section>
  );
}
