'use client';
// Табы ЛК менеджера (доп. Серёги 31.07): «Профиль» (сводка) · «Статистика»
// (прежняя детальная карточка) · «Награды» (полка + история начислений) ·
// «Магазин» (заглушка — механику Серёга обсудит отдельно). Дефолт — «Профиль».
// Только mode='manager': у агрегата отдела нет одной личности/полки/баланса,
// там прежняя структура (полка РОПа + «Моя команда» — не теряются).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

interface LedgerRow {
  id: number; date: string; badge_name: string | null; icon: string | null;
  tier: string | null; amount: number;
  // Выписка (доп. Серёги 31.07): source auto/manual_bonus/manual_penalty/convert/payout,
  // кем сделано, комментарий, причина штрафа, сторно-связи; currency — двухвалютная
  // система (EBALL/RUB, миграция 116).
  source: 'auto' | 'manual_bonus' | 'manual_penalty' | 'convert' | 'payout';
  currency: 'EBALL' | 'RUB';
  actor_login: string | null; comment: string | null;
  penalty_name: string | null; reversal_of: number | null; reversed: boolean;
}
interface ProfileExtra {
  tenure: { startDate: string; label: string | null } | null;
  ledger: LedgerRow[];
  rubBalance: number;
  rubToEballRate: number;
}

// Контекст ручных операций: право, бюджет, справочник с рассчитанными суммами.
interface ManualContext {
  canManual: boolean; currencyName?: string; balance?: number;
  budget?: { budget: number; left: number } | null;
  canReverse?: boolean;
  penaltyTypes?: { id: number; name: string; price: number; priceMode: 'fixed' | 'percent'; computedAmount: number }[];
}

function useManualContext(managerId: string, enabled: boolean) {
  return useQuery<ManualContext>({
    queryKey: ['badges-manual-ctx', managerId],
    queryFn: async () => {
      const res = await fetch(`/api/badges/manual?bitrixId=${encodeURIComponent(managerId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

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
  // Баланс может уходить в минус (ручные штрафы) — минус красным.
  const neg = balance < 0;
  const color = neg ? 'var(--color-negative, #e03131)' : 'var(--color-accent)';
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-2xl border ${big ? 'px-5 py-2.5' : 'px-3 py-1'}`}
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <span className={`font-extrabold tabular-nums ${big ? 'text-3xl' : 'text-xl'}`} style={{ color }}>{balance.toLocaleString('ru-RU')}</span>
      <span className={`font-semibold text-[var(--color-text-muted)] ${big ? 'text-sm' : 'text-xs'}`}>{currencyName}</span>
    </span>
  );
}

function RubPill({ balance, big = false }: { balance: number; big?: boolean }) {
  const neg = balance < 0;
  const color = neg ? 'var(--color-negative, #e03131)' : 'var(--color-positive, #2f9e44)';
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-2xl border ${big ? 'px-5 py-2.5' : 'px-3 py-1'}`}
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
      title="Рублёвый кошелёк: денежные бонусы; можно обменять на ебаллы или вывести в ЗП"
    >
      <span className={`font-extrabold tabular-nums ${big ? 'text-3xl' : 'text-xl'}`} style={{ color }}>{balance.toLocaleString('ru-RU')}</span>
      <span className={`font-semibold text-[var(--color-text-muted)] ${big ? 'text-sm' : 'text-xs'}`}>₽</span>
    </span>
  );
}

// ── Ручные поощрения/штрафы (доп. Серёги 31.07) ──────────────────────────────
// Кнопки видны РОПу и старше только для СВОИХ подчинённых (managed-depts, как
// «Моя команда»), админу — для всех; сервер отбивает вторым рубежом.

function ManualOpsModal({ managerId, managerName, kind, ctx, onClose, onDone }: {
  managerId: string; managerName: string; kind: 'bonus' | 'penalty';
  ctx: ManualContext; onClose: () => void; onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [typeId, setTypeId] = useState<number | null>(ctx.penaltyTypes?.[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const currency = ctx.currencyName ?? 'ебаллы';
  const selType = ctx.penaltyTypes?.find(t => t.id === typeId) ?? null;

  const submit = useMutation({
    mutationFn: async () => {
      let confirmText: string;
      let body: Record<string, unknown>;
      if (kind === 'bonus') {
        const v = Number(amount);
        if (!Number.isInteger(v) || v <= 0) throw new Error('Сумма — целое число больше нуля');
        if (!comment.trim()) throw new Error('Комментарий обязателен');
        confirmText = `Поощрить ${managerName} на ${v} ${currency}?\n\nКомментарий: ${comment.trim()}`;
        body = { bitrixId: Number(managerId), type: 'bonus', amount: v, comment: comment.trim() };
      } else {
        if (!selType) throw new Error('Выберите причину штрафа');
        // Подтверждающее окно с РАССЧИТАННОЙ суммой (для percent — от текущего баланса)
        confirmText = `Оштрафовать ${managerName} на ${selType.computedAmount} ${currency}` +
          (selType.priceMode === 'percent' ? ` (${selType.price}% от баланса ${ctx.balance ?? 0})` : '') +
          `?\n\nПричина: ${selType.name}${comment.trim() ? `\nКомментарий: ${comment.trim()}` : ''}`;
        body = { bitrixId: Number(managerId), type: 'penalty', penaltyTypeId: selType.id, comment: comment.trim() };
      }
      if (!window.confirm(confirmText)) return false;
      const res = await fetch('/api/badges/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return true;
    },
    onSuccess: (done) => { if (done) onDone(); },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-16 w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h2 className="mb-3 text-base font-bold text-[var(--color-text)]">
          {kind === 'bonus' ? 'Поощрить' : 'Оштрафовать'}: {managerName}
        </h2>
        <div className="flex flex-col gap-3">
          {kind === 'bonus' ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Сумма, {currency}
                <input value={amount} onChange={e => setAmount(e.target.value)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-right tabular-nums" placeholder="100" />
              </label>
              {ctx.budget && (
                <div className="text-xs text-[var(--color-text-muted)]">
                  Бюджет поощрений в этом месяце: осталось <b className="text-[var(--color-text)]">{ctx.budget.left}</b> из {ctx.budget.budget}
                </div>
              )}
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Комментарий (обязателен — за что поощрение)
                <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} maxLength={500}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm" />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Причина (размер фиксирован справочником)
                <select value={typeId ?? ''} onChange={e => setTypeId(Number(e.target.value))}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm">
                  {(ctx.penaltyTypes ?? []).map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {t.priceMode === 'percent' ? `${t.price}% от баланса (${t.computedAmount})` : t.price} {currency}
                    </option>
                  ))}
                </select>
              </label>
              {(ctx.penaltyTypes ?? []).length === 0 && (
                <div className="text-xs text-[var(--color-text-muted)]">Справочник штрафов пуст — причины создаёт админ в настройках.</div>
              )}
              {selType && (
                <div className="text-xs text-[var(--color-text-muted)]">
                  Спишется: <b className="text-[var(--color-negative,#e03131)]">−{selType.computedAmount} {currency}</b>
                  {selType.priceMode === 'percent' && <span> ({selType.price}% от текущего баланса {ctx.balance ?? 0}; сумма фиксируется на момент операции)</span>}
                </div>
              )}
              <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
                Комментарий (опционально)
                <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} maxLength={500}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm" />
              </label>
            </>
          )}
          {error && <div className="text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
            <button type="button" disabled={submit.isPending || (kind === 'penalty' && !selType)}
              onClick={() => { setError(null); submit.mutate(); }}
              className={`rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${kind === 'bonus' ? 'bg-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-negative,#e03131)]'}`}>
              {submit.isPending ? 'Сохранение…' : kind === 'bonus' ? 'Поощрить' : 'Оштрафовать'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Таб «Профиль»: сводка ────────────────────────────────────────────────────

export function ProfileTab({ managerId, isSelf, card, onGoRewards }: {
  managerId: string;
  isSelf: boolean;
  card: ManagerCardResult | undefined;
  onGoRewards: () => void;
}) {
  const qc = useQueryClient();
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  const { data: extra } = useProfileExtra(managerId, isSelf);
  const { data: planFact } = usePlanFact(managerId, 'manager');
  // Ручные операции: контекст только в чужой карточке (себя поощрять нельзя,
  // сервер это же и отбивает — canManual=false в своём ЛК у не-админов).
  const { data: manualCtx } = useManualContext(managerId, !isSelf);
  const [manualKind, setManualKind] = useState<'bonus' | 'penalty' | null>(null);
  const afterManual = () => {
    setManualKind(null);
    void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
    void qc.invalidateQueries({ queryKey: ['badges-manual-ctx'] });
  };

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
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {(extra?.rubBalance ?? 0) !== 0 && <RubPill balance={extra!.rubBalance} big />}
              <BalancePill balance={shelfData?.balance ?? 0} currencyName={shelfData?.currencyName ?? 'ебаллы'} big />
            </div>
            {manualCtx?.canManual && (
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => setManualKind('bonus')}
                  disabled={!!manualCtx.budget && manualCtx.budget.left <= 0}
                  title={manualCtx.budget && manualCtx.budget.left <= 0
                    ? `Бюджет поощрений на месяц исчерпан (${manualCtx.budget.budget}) — кнопка откроется в следующем месяце`
                    : 'Начислить поощрение'}
                  className="rounded-lg bg-[var(--color-positive,#2f9e44)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
                  Поощрить
                </button>
                <button type="button" onClick={() => setManualKind('penalty')}
                  className="rounded-lg bg-[var(--color-negative,#e03131)] px-3 py-1.5 text-xs font-semibold text-white">
                  Оштрафовать
                </button>
              </div>
            )}
            {manualCtx?.canManual && manualCtx.budget && manualCtx.budget.left <= 0 && (
              <div className="text-[11px] text-[var(--color-text-muted)]">Бюджет поощрений на месяц исчерпан</div>
            )}
          </div>
        </div>
        {manualKind && manualCtx && (
          <ManualOpsModal
            managerId={managerId}
            managerName={card?.profile.name ?? `#${managerId}`}
            kind={manualKind}
            ctx={manualCtx}
            onClose={() => setManualKind(null)}
            onDone={afterManual}
          />
        )}
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

// Описание строки выписки: авто — награда; ручные — кем и за что; сторно — «отмена…».
function ledgerTitle(r: LedgerRow): { title: string; sub: string | null } {
  if (r.reversal_of !== null) {
    return { title: r.comment ?? 'Отмена операции', sub: r.actor_login ? `админ: ${r.actor_login}` : null };
  }
  if (r.source === 'manual_bonus') {
    return { title: `Поощрение: ${r.comment || '—'}`, sub: r.actor_login ? `от ${r.actor_login}` : null };
  }
  if (r.source === 'manual_penalty') {
    return {
      title: `Штраф: ${r.penalty_name ?? '—'}${r.comment ? ` — ${r.comment}` : ''}`,
      sub: r.actor_login ? `от ${r.actor_login}` : null,
    };
  }
  if (r.source === 'convert') return { title: r.comment ?? 'Конвертация', sub: null };
  if (r.source === 'payout') return { title: r.comment ?? 'Вывод в ЗП', sub: r.actor_login ? `подтвердил ${r.actor_login}` : null };
  return { title: r.badge_name ?? '—', sub: null };
}

// Публичный справочник штрафов: все менеджеры видят «за что и сколько» (read-only).
function PenaltyCatalog() {
  const { data } = useQuery<{ currencyName: string; types: { id: number; name: string; price: number; priceMode: string }[] }>({
    queryKey: ['penalty-types-public'],
    queryFn: async () => {
      const res = await fetch('/api/badges/penalty-types');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const types = data?.types ?? [];
  if (types.length === 0) return null;
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">Справочник штрафов</h2>
        <span className="text-xs text-[var(--color-text-muted)]">за что и сколько</span>
      </div>
      <div className="flex flex-col">
        {types.map(t => (
          <div key={t.id} className="flex items-baseline justify-between gap-3 border-t border-[var(--color-border)] py-1.5 first:border-t-0 text-[13px]">
            <span className="text-[var(--color-text)]">{t.name}</span>
            <span className="whitespace-nowrap font-semibold tabular-nums text-[var(--color-negative,#e03131)]">
              −{t.priceMode === 'percent' ? `${t.price}% от баланса` : `${t.price} ${data?.currencyName ?? 'ебаллы'}`}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Рублёвый кошелёк (доп. Серёги 31.07, миграция 116) ───────────────────────
// Конвертация ТОЛЬКО RUB → EBALL; вывод в ЗП заявкой. Кнопки — только в своём ЛК.

interface PayoutRow {
  id: number; amount: number; status: 'requested' | 'paid' | 'rejected';
  comment: string | null; resolver_login: string | null;
  requested_at: string; resolved_at: string | null;
}

const PAYOUT_STATUS: Record<string, { label: string; color: string }> = {
  requested: { label: 'на рассмотрении', color: 'var(--color-accent)' },
  paid: { label: 'выплачено', color: 'var(--color-positive, #2f9e44)' },
  rejected: { label: 'отклонено', color: 'var(--color-negative, #e03131)' },
};

function RubWalletBlock({ managerId, isSelf, extra, currencyName }: {
  managerId: string; isSelf: boolean; extra: ProfileExtra | undefined; currencyName: string;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const rub = extra?.rubBalance ?? 0;
  const rate = extra?.rubToEballRate ?? 1;

  const { data: payouts } = useQuery<{ requests: PayoutRow[] }>({
    queryKey: ['badges-payouts-my'],
    queryFn: async () => {
      const res = await fetch('/api/badges/payout');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: isSelf,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
    void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
    void qc.invalidateQueries({ queryKey: ['badges-payouts-my'] });
  };

  const convert = useMutation({
    mutationFn: async () => {
      const raw = window.prompt(`Сколько рублей обменять на ${currencyName}? (курс: 1 ₽ = ${rate} ${currencyName}, доступно ${rub} ₽)`);
      if (raw === null) return false;
      const v = Number(raw);
      if (!Number.isInteger(v) || v <= 0) throw new Error('Сумма — целое число больше нуля');
      if (!window.confirm(`Обменять ${v} ₽ на ${Math.round(v * rate)} ${currencyName}? Обратной конвертации нет.`)) return false;
      const res = await fetch('/api/badges/convert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: v }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return true;
    },
    onSuccess: (done) => { if (done) { setError(null); refresh(); } },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const payout = useMutation({
    mutationFn: async () => {
      const raw = window.prompt(`Сколько рублей вывести в ЗП? (доступно ${rub} ₽)`);
      if (raw === null) return false;
      const v = Number(raw);
      if (!Number.isInteger(v) || v <= 0) throw new Error('Сумма — целое число больше нуля');
      if (!window.confirm(`Подать заявку на вывод ${v} ₽ в зарплату? Выплату подтверждает руководитель.`)) return false;
      const res = await fetch('/api/badges/payout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: v }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return true;
    },
    onSuccess: (done) => { if (done) { setError(null); refresh(); } },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const requests = payouts?.requests ?? [];
  if (!isSelf && rub === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-[var(--color-text)]">Рублёвый кошелёк</h2>
        <RubPill balance={rub} />
        {isSelf && (
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" onClick={() => convert.mutate()} disabled={convert.isPending || rub <= 0}
              className="rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:opacity-40">
              Обменять на {currencyName}
            </button>
            <button type="button" onClick={() => payout.mutate()} disabled={payout.isPending || rub <= 0}
              className="rounded-lg bg-[var(--color-positive,#2f9e44)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
              Вывести в ЗП
            </button>
          </div>
        )}
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        Денежные бонусы копятся в рублях. Обмен на {currencyName} — по курсу 1 ₽ = {rate} (только в одну сторону);
        вывод в ЗП — заявкой, выплату подтверждает руководитель.
      </div>
      {error && <div className="mt-1 text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
      {isSelf && requests.length > 0 && (
        <div className="mt-3 flex flex-col">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Мои заявки на вывод</div>
          {requests.map(r => {
            const st = PAYOUT_STATUS[r.status];
            return (
              <div key={r.id} className="flex flex-wrap items-baseline gap-2 border-t border-[var(--color-border)] py-1.5 text-[13px]">
                <span className="tabular-nums text-[var(--color-text-muted)]">{r.requested_at.slice(0, 10).split('-').reverse().join('.')}</span>
                <span className="font-semibold tabular-nums text-[var(--color-text)]">{r.amount.toLocaleString('ru-RU')} ₽</span>
                <span className="text-xs font-semibold" style={{ color: st.color }}>{st.label}</span>
                {r.status === 'rejected' && r.comment && (
                  <span className="text-xs text-[var(--color-text-muted)]">причина: {r.comment}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function RewardsTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const qc = useQueryClient();
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  const { data: extra, isLoading } = useProfileExtra(managerId, isSelf);
  const { data: manualCtx } = useManualContext(managerId, !isSelf);
  const currencyName = shelfData?.currencyName ?? 'ебаллы';
  const ledger = extra?.ledger ?? [];

  // Сторно (только админ): компенсирующая запись, история сохраняется.
  const reverse = useMutation({
    mutationFn: async (ledgerId: number) => {
      const res = await fetch('/api/badges/manual/reverse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ledgerId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
      void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
      void qc.invalidateQueries({ queryKey: ['badges-manual-ctx'] });
    },
  });

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <BadgeShelf managerId={isSelf ? undefined : managerId} />
      <RubWalletBlock managerId={managerId} isSelf={isSelf} extra={extra} currencyName={currencyName} />
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">Выписка</h2>
          <span className="text-xs text-[var(--color-text-muted)]">награды, поощрения и штрафы</span>
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
                  <th className="py-1.5 pr-3 font-bold">Операция</th>
                  <th className="py-1.5 text-right font-bold">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => {
                  const { title, sub } = ledgerTitle(r);
                  const neg = r.amount < 0;
                  return (
                    <tr key={r.id} className={`border-t border-[var(--color-border)] ${r.reversed ? 'opacity-60' : ''}`}>
                      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">
                        {r.date.split('-').reverse().join('.')}
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.icon && r.source === 'auto' && <span className="mr-1.5">{r.icon}</span>}
                        <span className="text-[var(--color-text)]">{title}</span>
                        {r.tier && (
                          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">
                            {TIER_LABELS[r.tier as BadgeTier] ?? r.tier}
                          </span>
                        )}
                        {sub && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{sub}</span>}
                        {r.reversed && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">(отменена)</span>}
                        {manualCtx?.canReverse && r.source !== 'auto' && !r.reversed && r.reversal_of === null && (
                          <button type="button"
                            onClick={() => { if (window.confirm('Сторнировать операцию? Появится компенсирующая запись.')) reverse.mutate(r.id); }}
                            className="ml-2 text-[11px] font-semibold text-[var(--color-accent)] hover:underline">
                            сторно
                          </button>
                        )}
                      </td>
                      <td className="py-1.5 text-right font-semibold tabular-nums whitespace-nowrap"
                          style={{ color: neg ? 'var(--color-negative, #e03131)' : 'var(--color-positive, #2f9e44)' }}>
                        {neg ? '' : '+'}{r.amount.toLocaleString('ru-RU')}
                        <span className="ml-1 text-[11px] font-normal text-[var(--color-text-muted)]">
                          {r.currency === 'RUB' ? '₽' : currencyName}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <PenaltyCatalog />
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
