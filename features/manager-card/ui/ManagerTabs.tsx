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
import { GachaBlock } from '@/features/badges/ui/GachaBlock';
import { TIER_LABELS, type BadgeTier } from '@/features/badges/engine/catalog';
import { usePlanFact } from './PlanFactStrip';
import type { ManagerCardResult } from '@/features/manager-card/engine/managerCard';

export type ManagerTabKey = 'profile' | 'stats' | 'rewards' | 'shop' | 'inventory';

export const MANAGER_TABS: { key: ManagerTabKey; label: string }[] = [
  { key: 'profile', label: 'Профиль' },
  { key: 'stats', label: 'Статистика' },
  { key: 'rewards', label: 'Награды' },
  { key: 'shop', label: 'Магазин' },
  { key: 'inventory', label: 'Инвентарь' },
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
  source: 'auto' | 'manual_bonus' | 'manual_penalty' | 'convert' | 'payout'
    | 'shop_purchase' | 'shop_refund' | 'expiry' | 'release_zero' | 'release_grant'
    | 'gacha_spin' | 'gacha_prize' | 'transfer_out' | 'transfer_in' | 'transfer_fee';
  currency: 'EBALL' | 'RUB';
  actor_login: string | null; comment: string | null;
  penalty_name: string | null; reversal_of: number | null; reversed: boolean;
}
interface ProfileExtra {
  tenure: { startDate: string; label: string | null } | null;
  ledger: LedgerRow[];
  rubBalance: number;
  rubToEballRate: number;
  // Плашка TTL (31.07): сколько ебаллов сгорит в ближайшие 30 дней и через
  // сколько дней первое сгорание (0 = ближайшей ночью).
  expiring: { amount: number; days: number } | null;
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

// Плашка TTL ебаллов (31.07): «сгорит N через X дней» — живые FIFO-остатки
// начислений, чей срок жизни (ttl_months из настроек) выходит в ближайшие 30 дней.
function ExpiringPill({ expiring, currencyName }: {
  expiring: { amount: number; days: number } | null | undefined; currencyName: string;
}) {
  if (!expiring || expiring.amount <= 0) return null;
  const when = expiring.days <= 0 ? 'сегодня ночью' : expiring.days === 1 ? 'через 1 день' : `через ${expiring.days} дн.`;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-2xl border px-3 py-1 text-xs font-semibold"
      style={{
        color: 'var(--color-warning, #e8590c)',
        borderColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 40%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 10%, transparent)',
      }}
      title={`Срок жизни начислений истекает — потратьте их в магазине, пока не сгорели (горизонт 30 дней)`}
    >
      🔥 Сгорит {expiring.amount.toLocaleString('ru-RU')} {currencyName} {when}
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
            <ExpiringPill expiring={extra?.expiring} currencyName={shelfData?.currencyName ?? 'ебаллы'} />
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
  // Магазин и TTL (31.07): покупка/возврат 50% при истечении предмета/сгорание.
  if (r.source === 'shop_purchase') return { title: r.comment ?? 'Покупка в магазине', sub: null };
  if (r.source === 'shop_refund') return { title: r.comment ?? 'Возврат 50% за истёкший предмет', sub: null };
  if (r.source === 'expiry') return { title: r.comment ?? 'Сгорание ебаллов (истёк срок жизни)', sub: null };
  if (r.source === 'gacha_spin') return { title: r.comment ?? 'Крутка гачи 🎰', sub: null };
  if (r.source === 'gacha_prize') return { title: r.comment ?? 'Выигрыш в гаче', sub: null };
  if (r.source === 'transfer_out') return { title: r.comment ?? 'Перевод коллеге', sub: null };
  if (r.source === 'transfer_in') return { title: r.comment ?? 'Перевод от коллеги', sub: null };
  if (r.source === 'transfer_fee') return { title: r.comment ?? 'Комиссия за перевод', sub: null };
  if (r.source === 'release_zero' || r.source === 'release_grant') {
    return { title: r.comment ?? 'Релизный старт', sub: r.actor_login ? `админ: ${r.actor_login}` : null };
  }
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
      {extra?.expiring && extra.expiring.amount > 0 && (
        <div><ExpiringPill expiring={extra.expiring} currencyName={currencyName} /></div>
      )}
      <RubWalletBlock managerId={managerId} isSelf={isSelf} extra={extra} currencyName={currencyName} />
      {isSelf && <TransferBlock balance={shelfData?.balance ?? 0} currencyName={currencyName} />}
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

// ── Магазин и инвентарь (MVP 31.07 + пакет переводов/подарков) ───────────────
// Данные общие (/api/shop): витрина — таб «Магазин», предметы — таб «Инвентарь».

interface ShopItemView {
  id: number; name: string; description: string | null; category: 'material' | 'immaterial' | 'team';
  priceEball: number; priceRub: number | null; allowedCurrencies: string[];
  stock: number | null; ttlMonths: number;
}
interface GiftHop { from: number; fromName: string; to: number; toName: string; at: string }
interface InventoryRow {
  id: number; shop_item_id: number; item_name: string; price_paid: number; currency: 'EBALL' | 'RUB';
  status: 'owned' | 'activation_requested' | 'used' | 'expired' | 'refunded';
  purchased_at: string; expires_at: string; activation_comment: string | null;
  resolver_login: string | null; resolve_comment: string | null; resolved_at: string | null;
  gift_history: GiftHop[];
}
interface ShopData {
  currencyName: string; rate: number; balance: number; rubBalance: number;
  items: ShopItemView[]; inventory: InventoryRow[];
}

function useShopData(managerId: string, isSelf: boolean) {
  return useQuery<ShopData>({
    queryKey: ['shop', isSelf ? 'me' : managerId],
    queryFn: async () => {
      const qs = isSelf ? '' : `?bitrixId=${encodeURIComponent(managerId)}`;
      const res = await fetch(`/api/shop${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

const SHOP_CATEGORIES: { key: ShopItemView['category']; label: string }[] = [
  { key: 'immaterial', label: 'Нематериальные' },
  { key: 'material', label: 'Материальные' },
  { key: 'team', label: 'Командные (складчина отдела)' },
];

const INVENTORY_STATUS: Record<InventoryRow['status'], { label: string; color: string }> = {
  owned: { label: 'в инвентаре', color: 'var(--color-accent)' },
  activation_requested: { label: 'заявка у руководителя', color: 'var(--color-warning, #e8590c)' },
  used: { label: 'использован', color: 'var(--color-positive, #2f9e44)' },
  expired: { label: 'срок истёк (возврат 50%)', color: 'var(--color-text-muted)' },
  refunded: { label: 'возвращён', color: 'var(--color-text-muted)' },
};

function fmtDate(iso: string): string { return iso.slice(0, 10).split('-').reverse().join('.'); }

// Список активных менеджеров + параметры переводов (комиссия, лимит).
interface TransferMeta {
  currencyName: string; feePercent: number; dailyLimit: number; sentToday: number;
  managers: { id: number; name: string }[];
}
function useTransferMeta(enabled: boolean) {
  return useQuery<TransferMeta>({
    queryKey: ['shop-transfer-meta'],
    queryFn: async () => {
      const res = await fetch('/api/shop/transfer');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}

// ── Таб «Магазин»: гача + витрина ────────────────────────────────────────────

export function ShopTab({ managerId, isSelf, onGoInventory }: {
  managerId: string; isSelf: boolean; onGoInventory?: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useShopData(managerId, isSelf);
  const currencyName = data?.currencyName ?? 'ебаллы';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shop'] });
    void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  const buy = useMutation({
    mutationFn: async ({ item, currency }: { item: ShopItemView; currency: 'EBALL' | 'RUB' }) => {
      const price = currency === 'RUB' ? item.priceRub! : item.priceEball;
      const unit = currency === 'RUB' ? '₽' : currencyName;
      const balance = currency === 'RUB' ? (data?.rubBalance ?? 0) : (data?.balance ?? 0);
      if (!window.confirm(
        `Купить «${item.name}» за ${price.toLocaleString('ru-RU')} ${unit}?\n\n` +
        `Останется: ${(balance - price).toLocaleString('ru-RU')} ${unit}. ` +
        `Предмет попадёт в инвентарь, срок годности ${item.ttlMonths} мес.`,
      )) return false;
      const res = await fetch('/api/shop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, currency }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return true;
    },
    onSuccess: (done) => { if (done) { setError(null); refresh(); } },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const items = data?.items ?? [];
  const activeCount = (data?.inventory ?? []).filter(i => i.status === 'owned' || i.status === 'activation_requested').length;

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <BalancePill balance={data?.balance ?? 0} currencyName={currencyName} />
        {(data?.rubBalance ?? 0) !== 0 && <RubPill balance={data!.rubBalance} />}
        {onGoInventory && (
          <button type="button" onClick={onGoInventory}
            className="ml-auto text-xs font-semibold text-[var(--color-accent)] hover:underline">
            🎒 Мой инвентарь{activeCount > 0 ? ` (${activeCount})` : ''} →
          </button>
        )}
        {error && <span className="text-xs text-[var(--color-negative,#e03131)]">{error}</span>}
      </div>

      {/* Гача (фаза 2): колесо, крутки только в своём ЛК */}
      <GachaBlock isSelf={isSelf} />

      {/* Витрина по категориям */}
      {SHOP_CATEGORIES.map(cat => {
        const catItems = items.filter(i => i.category === cat.key);
        if (catItems.length === 0) return null;
        return (
          <section key={cat.key} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
            <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{cat.label}</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {catItems.map(item => {
                const soldOut = item.stock !== null && item.stock <= 0;
                const canEball = (data?.balance ?? 0) >= item.priceEball;
                const canRub = item.priceRub !== null && (data?.rubBalance ?? 0) >= item.priceRub;
                return (
                  <div key={item.id} className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] px-3.5 py-3">
                    <div className="font-semibold text-[var(--color-text)] text-[14px]">{item.name}</div>
                    {item.description && <div className="text-xs text-[var(--color-text-muted)]">{item.description}</div>}
                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                      <span className="font-extrabold tabular-nums text-[var(--color-accent)]">
                        {item.priceEball.toLocaleString('ru-RU')} <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">{currencyName}</span>
                      </span>
                      {item.priceRub !== null && (
                        <span className="text-xs text-[var(--color-text-muted)] tabular-nums">или {item.priceRub.toLocaleString('ru-RU')} ₽</span>
                      )}
                      {item.stock !== null && (
                        <span className="text-[11px] text-[var(--color-text-muted)]">осталось {item.stock}</span>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">срок годности {item.ttlMonths} мес</div>
                    {isSelf && (
                      <div className="flex gap-2">
                        <button type="button" disabled={buy.isPending || soldOut || !canEball}
                          onClick={() => buy.mutate({ item, currency: 'EBALL' })}
                          title={soldOut ? 'Позиция закончилась' : canEball ? undefined : `Не хватает ${currencyName}`}
                          className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-inverse)] disabled:opacity-40">
                          {soldOut ? 'Нет в наличии' : 'Купить'}
                        </button>
                        {item.priceRub !== null && !soldOut && (
                          <button type="button" disabled={buy.isPending || !canRub}
                            onClick={() => buy.mutate({ item, currency: 'RUB' })}
                            title={canRub ? undefined : 'Не хватает рублей'}
                            className="rounded-lg border border-[var(--color-positive,#2f9e44)] px-3 py-1.5 text-xs font-semibold text-[var(--color-positive,#2f9e44)] disabled:opacity-40">
                            За ₽
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      <div className="text-[11px] text-[var(--color-text-muted)]">
        Покупка списывает {currencyName} сразу (старейшие начисления первыми), предмет попадает в таб «Инвентарь» со
        сроком годности. Активация — заявкой руководителю; отказ возвращает предмет. По истечении срока возвращается 50% цены.
      </div>
    </div>
  );
}

// ── Таб «Инвентарь»: предметы + подарки коллегам ─────────────────────────────

function GiftModal({ row, meta, onClose, onDone }: {
  row: InventoryRow; meta: TransferMeta; onClose: () => void; onDone: () => void;
}) {
  const [to, setTo] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  const gift = useMutation({
    mutationFn: async () => {
      if (to === '') throw new Error('Выберите получателя');
      const toName = meta.managers.find(m => m.id === to)?.name ?? to;
      if (!window.confirm(`Подарить «${row.item_name}» → ${toName}?\n\nПредмет уйдёт из вашего инвентаря, срок годности (до ${fmtDate(row.expires_at)}) сохранится.`)) return false;
      const res = await fetch('/api/shop/gift', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryId: row.id, toBitrixId: to }),
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
      <div className="mt-16 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h2 className="mb-3 text-base font-bold text-[var(--color-text)]">Подарить: {row.item_name}</h2>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Кому (активный менеджер)
          <select value={to} onChange={e => setTo(e.target.value === '' ? '' : Number(e.target.value))}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]">
            <option value="">— выберите —</option>
            {meta.managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <div className="mt-2 text-xs text-[var(--color-text-muted)]">Без комиссии; срок годности сохраняется; получателю придёт уведомление.</div>
        {error && <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={gift.isPending || to === ''} onClick={() => { setError(null); gift.mutate(); }}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {gift.isPending ? 'Отправка…' : 'Подарить'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InventoryTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [gifting, setGifting] = useState<InventoryRow | null>(null);
  const { data } = useShopData(managerId, isSelf);
  const { data: meta } = useTransferMeta(isSelf);
  const currencyName = data?.currencyName ?? 'ебаллы';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shop'] });
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  const activate = useMutation({
    mutationFn: async (row: InventoryRow) => {
      const comment = window.prompt(`Заявка руководителю на «${row.item_name}».\nПожелание (дата и т.п.) — необязательно:`);
      if (comment === null) return false;
      const res = await fetch('/api/shop/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryId: row.id, comment: comment.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return true;
    },
    onSuccess: (done) => { if (done) { setError(null); refresh(); } },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const inventory = data?.inventory ?? [];
  const active = inventory.filter(i => i.status === 'owned' || i.status === 'activation_requested');
  const history = inventory.filter(i => i.status !== 'owned' && i.status !== 'activation_requested');

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <BalancePill balance={data?.balance ?? 0} currencyName={currencyName} />
        {(data?.rubBalance ?? 0) !== 0 && <RubPill balance={data!.rubBalance} />}
        {error && <span className="text-xs text-[var(--color-negative,#e03131)]">{error}</span>}
      </div>
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">🎒 Мой инвентарь</h2>
          {active.length > 0 && <span className="text-xs text-[var(--color-text-muted)]">{active.length}</span>}
        </div>
        {active.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">
            Пусто — призы из магазина и гачи появятся здесь. Нематериальные активируются заявкой руководителю.
          </div>
        ) : (
          <div className="flex flex-col">
            {active.map(row => {
              const st = INVENTORY_STATUS[row.status];
              const gifted = (row.gift_history ?? []).length > 0;
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] py-2 text-[13px] first:border-t-0">
                  <span className="font-semibold text-[var(--color-text)]">{row.item_name}</span>
                  <span className="text-xs font-semibold" style={{ color: st.color }}>{st.label}</span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    куплен {fmtDate(row.purchased_at)} · годен до {fmtDate(row.expires_at)}
                  </span>
                  {gifted && (
                    <span className="text-xs text-[var(--color-text-muted)]"
                      title={(row.gift_history ?? []).map(h => `${h.fromName} → ${h.toName} (${h.at})`).join('\n')}>
                      🎁 подарок от {row.gift_history[row.gift_history.length - 1].fromName}
                    </span>
                  )}
                  {row.resolve_comment && row.status === 'owned' && (
                    <span className="text-xs text-[var(--color-negative,#e03131)]">отклонено: {row.resolve_comment}</span>
                  )}
                  {isSelf && row.status === 'owned' && (
                    <span className="ml-auto flex gap-2">
                      <button type="button" onClick={() => activate.mutate(row)} disabled={activate.isPending}
                        className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-[var(--color-text-inverse)] disabled:opacity-50">
                        Использовать
                      </button>
                      {meta && (
                        <button type="button" onClick={() => setGifting(row)}
                          className="rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs font-semibold hover:bg-[var(--color-bg-hover)]">
                          Подарить
                        </button>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {history.length > 0 && (
          <div className="mt-3 flex flex-col opacity-70">
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">История</div>
            {history.slice(0, 15).map(row => {
              const st = INVENTORY_STATUS[row.status];
              return (
                <div key={row.id} className="flex flex-wrap items-baseline gap-2.5 border-t border-[var(--color-border)] py-1.5 text-[12.5px]">
                  <span className="text-[var(--color-text)]">{row.item_name}</span>
                  <span className="text-xs font-semibold" style={{ color: st.color }}>{st.label}</span>
                  {row.resolved_at && <span className="text-xs text-[var(--color-text-muted)]">{fmtDate(row.resolved_at)}</span>}
                  {row.resolver_login && row.status === 'used' && (
                    <span className="text-xs text-[var(--color-text-muted)]">одобрил {row.resolver_login}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      {gifting && meta && (
        <GiftModal row={gifting} meta={meta} onClose={() => setGifting(null)}
          onDone={() => { setGifting(null); refresh(); }} />
      )}
    </div>
  );
}

// ── Перевод ебаллов коллеге (блок в табе «Награды») ──────────────────────────

export function TransferBlock({ balance, currencyName }: { balance: number; currencyName: string }) {
  const qc = useQueryClient();
  const { data: meta } = useTransferMeta(true);
  const [to, setTo] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      const v = Number(amount);
      if (to === '') throw new Error('Выберите получателя');
      if (!Number.isInteger(v) || v <= 0) throw new Error('Сумма — целое число больше нуля');
      const fee = Math.floor(v * (meta?.feePercent ?? 5) / 100);
      const toName = meta?.managers.find(m => m.id === to)?.name ?? to;
      if (!window.confirm(
        `Перевести ${v} ${currencyName} → ${toName}?\n\nПолучит: ${v - fee} (комиссия ${meta?.feePercent ?? 5}% = ${fee} сжигается).` +
        (comment.trim() ? `\nКомментарий: ${comment.trim()}` : ''),
      )) return false;
      const res = await fetch('/api/shop/transfer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toBitrixId: to, amount: v, comment: comment.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return json as { received: number; fee: number };
    },
    onSuccess: (r) => {
      if (r === false) return;
      setError(null); setAmount(''); setComment(''); setTo('');
      setOkMsg(`Готово: получателю дошло ${(r as { received: number }).received}, комиссия ${(r as { fee: number }).fee} сожжена`);
      void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
      void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
      void qc.invalidateQueries({ queryKey: ['shop-transfer-meta'] });
    },
    onError: (e) => { setOkMsg(null); setError(e instanceof Error ? e.message : String(e)); },
  });

  if (!meta) return null;
  const left = Math.max(0, meta.dailyLimit - meta.sentToday);
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">💸 Перевести коллеге</h2>
        <span className="text-xs text-[var(--color-text-muted)]">
          комиссия {meta.feePercent}% (сжигается) · лимит {meta.dailyLimit}/день, сегодня доступно {left}
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex min-w-52 flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Кому
          <select value={to} onChange={e => setTo(e.target.value === '' ? '' : Number(e.target.value))}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]">
            <option value="">— выберите менеджера —</option>
            {meta.managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Сумма
          <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="100"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-right text-sm tabular-nums text-[var(--color-text)]" />
        </label>
        <label className="flex min-w-52 flex-1 flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Комментарий (получатель увидит)
          <input value={comment} onChange={e => setComment(e.target.value)} maxLength={300} placeholder="С днём рождения!"
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]" />
        </label>
        <button type="button" disabled={send.isPending || to === '' || !amount.trim() || balance <= 0}
          onClick={() => send.mutate()}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
          {send.isPending ? 'Отправка…' : 'Перевести'}
        </button>
      </div>
      {amount.trim() !== '' && Number(amount) > 0 && (
        <div className="mt-1.5 text-xs text-[var(--color-text-muted)]">
          Получателю дойдёт <b className="text-[var(--color-text)]">{Number(amount) - Math.floor(Number(amount) * meta.feePercent / 100)}</b>,
          комиссия {Math.floor(Number(amount) * meta.feePercent / 100)} сожжётся.
        </div>
      )}
      {okMsg && <div className="mt-1.5 text-xs text-[var(--color-positive,#2f9e44)]">{okMsg}</div>}
      {error && <div className="mt-1.5 text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
    </section>
  );
}

// ── Колокольчик уведомлений (шапка ЛК) ───────────────────────────────────────

interface NotificationRow {
  id: number; type: string; title: string; body: string | null; link: string | null;
  unread: boolean; at: string;
}

export function NotificationsBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery<{ notifications: NotificationRow[]; unread: number }>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await fetch('/api/notifications');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
  const markAll = useMutation({
    mutationFn: async () => {
      await fetch('/api/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = data?.unread ?? 0;
  const list = data?.notifications ?? [];
  return (
    <div className="relative">
      <button type="button" onClick={() => { setOpen(o => !o); }}
        title="Уведомления"
        className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 text-base hover:bg-[var(--color-bg-hover)]">
        🔔
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-negative,#e03131)] px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-96 max-w-[90vw] rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 shadow-xl">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-sm font-bold text-[var(--color-text)]">Уведомления</span>
            {unread > 0 && (
              <button type="button" onClick={() => markAll.mutate()}
                className="text-xs font-semibold text-[var(--color-accent)] hover:underline">
                Прочитать все ({unread})
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {list.length === 0 ? (
              <div className="py-4 text-center text-sm text-[var(--color-text-muted)]">Пока пусто</div>
            ) : list.map(n => (
              <div key={n.id} className={`border-t border-[var(--color-border)] py-2 first:border-t-0 ${n.unread ? '' : 'opacity-60'}`}>
                <div className="flex items-baseline gap-2">
                  {n.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" />}
                  <span className="text-[13px] font-semibold text-[var(--color-text)]">{n.title}</span>
                  <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-[var(--color-text-muted)]">{n.at.slice(5, 16).replace('-', '.')}</span>
                </div>
                {n.body && <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{n.body}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
