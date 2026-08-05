'use client';
// Табы ЛК менеджера (доп. Серёги 31.07): «Профиль» (сводка) · «Статистика»
// (прежняя детальная карточка) · «Награды» (полка + история начислений) ·
// «Магазин» (заглушка — механику Серёга обсудит отдельно). Дефолт — «Профиль».
// Только mode='manager': у агрегата отдела нет одной личности/полки/баланса,
// там прежняя структура (полка РОПа + «Моя команда» — не теряются).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Camera } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { coverStyle } from '@/lib/profile/covers';
import { CoverPicker } from '@/features/profile/ui/CoverPicker';
import { ProfileFeed } from '@/features/profile/ui/ProfileFeed';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PinDialog } from '@/components/ui/PinDialog';
import { PinSetupDialog } from '@/components/ui/PinSetupDialog';
import { fetchPinGated } from '@/lib/client/pinFetch';
import { BadgeCard, BadgeShelf, useShelfQuery } from '@/features/badges/ui/BadgeShelf';
import { TIER_LABELS, type BadgeTier } from '@/features/badges/engine/catalog';
import { usePlanFact } from './PlanFactStrip';
import { MltCoin } from '@/components/icons/MltCoin';
import type { ManagerCardResult } from '@/features/manager-card/engine/managerCard';

export type ManagerTabKey = 'profile' | 'planyorka' | 'customers' | 'quests' | 'stats' | 'rewards' | 'wallet' | 'shop' | 'wheel' | 'inventory';

export const MANAGER_TABS: { key: ManagerTabKey; label: string }[] = [
  { key: 'profile', label: 'Профиль' },
  // «Планёрка» (задача владельца 01.08): сводка «где деньги, что делать» —
  // features/planyorka. Шаблонный текст из данных, без LLM.
  { key: 'planyorka', label: 'Планёрка' },
  // «Мои заказчики» (фича Серёги 01.08): кому пора позвонить — features/customers.
  { key: 'customers', label: 'Мои заказчики' },
  // Квесты (миграция 125): миссии с наградами — features/quests.
  { key: 'quests', label: 'Квесты' },
  { key: 'stats', label: 'Статистика' },
  { key: 'rewards', label: 'Награды' },
  // «Кошелёк» (правка владельца 05.08): все финансы в одном разделе — балансы,
  // обмен/вывод, переводы, график начислений, выписка (features/wallet).
  { key: 'wallet', label: 'Кошелёк' },
  { key: 'shop', label: 'Магазин' },
  // «Колесо фортуны» (правка владельца 05.08): гача выделена из магазина в
  // собственный раздел с полноэкранным колесом.
  { key: 'wheel', label: 'Колесо фортуны' },
  { key: 'inventory', label: 'Инвентарь' },
];

export function ManagerTabBar({ active, onChange, hidden }: {
  active: ManagerTabKey; onChange: (t: ManagerTabKey) => void;
  // Табы за фиче-флагом (01.08: «Планёрка» спрятана — feature_flags.planyorka_enabled)
  // фильтруются здесь, не в самом списке MANAGER_TABS — код таба остаётся нетронутым.
  hidden?: ManagerTabKey[];
}) {
  const tabs = hidden?.length ? MANAGER_TABS.filter(t => !hidden.includes(t.key)) : MANAGER_TABS;

  // Мобильное поведение полосы вкладок (задача 2779 — владелец со скрина: полоса
  // обрезана по краю, непонятно, что листается; следом — уточнение: без
  // собственного скролл-контейнера полоса РАСПИРАЛА ВСЮ СТРАНИЦУ по горизонтали).
  // Скролл-контейнер уже был (overflow-x-auto ниже), но: 1) без видимого
  // индикатора «есть продолжение» — человек не понимает, что можно листать;
  // 2) активная вкладка не попадала в видимую область при заходе по прямой
  // ссылке (deep link на «Инвентарь» — а видно «Профиль»); 3) сам факт, что
  // страница ехала целиком — отдельный баг родительской обёртки, см. фикс
  // min-w-0/overflow-x-hidden в ManagerCardPage.tsx, тут его нет и не будет.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const firstRun = useRef(true);

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFade({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    updateFade();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateFade, { passive: true });
    const ro = new ResizeObserver(updateFade);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', updateFade); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateFade, tabs.length]);

  useEffect(() => {
    // Автоскролл активной вкладки в видимую область — обязательное условие
    // задачи: заход по прямой ссылке (?tab=inventory) должен сразу показывать,
    // какая вкладка активна, а не оставлять её за правым краем. Первый заход —
    // без анимации (иначе полоса дёргается сразу после открытия страницы),
    // переключение табов кликом — плавно.
    const el = scrollRef.current;
    if (!el) return;
    const activeBtn = el.querySelector<HTMLElement>(`[data-tab-key="${active}"]`);
    activeBtn?.scrollIntoView({ behavior: firstRun.current ? 'auto' : 'smooth', inline: 'nearest', block: 'nearest' });
    firstRun.current = false;
  }, [active]);

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="scroll-x scrollbar-none flex snap-x snap-proximity gap-1 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1"
      >
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            data-tab-key={t.key}
            onClick={() => onChange(t.key)}
            className={`min-h-11 flex-1 snap-start whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
              active === t.key
                ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Градиент-затухание у края — единственный индикатор «есть продолжение»,
          который остаётся честным (появляется/пропадает по факту scrollLeft),
          а не декоративная стрелка, которая может соврать. Цвет фона строго
          --color-bg-surface — тот же, что у самой полосы, иначе на границе
          будет видна ступенька. */}
      {fade.left && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-2xl"
          style={{ background: 'linear-gradient(to right, var(--color-bg-surface), transparent)' }}
        />
      )}
      {fade.right && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-2xl"
          style={{ background: 'linear-gradient(to left, var(--color-bg-surface), transparent)' }}
        />
      )}
    </div>
  );
}

// ── общие данные табов ───────────────────────────────────────────────────────

export interface LedgerRow {
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
export interface ProfileExtra {
  tenure: { startDate: string; label: string | null } | null;
  ledger: LedgerRow[];
  rubBalance: number;
  rubToEballRate: number;
  // Плашка TTL (31.07): сколько MLT сгорит в ближайшие 30 дней и через
  // сколько дней первое сгорание (0 = ближайшей ночью).
  expiring: { amount: number; days: number } | null;
  // XP-система (01.08, миграция 124): уровень/титул/классы.
  xp: {
    totalXp: number; level: number; title: string;
    nextLevelXp: number; currentLevelXp: number;
    classes: { name: string; xp: number; level: number; progress: number }[];
    topClass: { name: string; level: number } | null;
  } | null;
  // Обложка профиля (ЛК-соцсетка этап 2, миграция 149): null = дефолтная.
  coverId: string | null;
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

export function BalancePill({ balance, currencyName, big = false }: { balance: number; currencyName: string; big?: boolean }) {
  // Баланс может уходить в минус (ручные штрафы) — минус красным.
  const neg = balance < 0;
  const color = neg ? 'var(--color-negative, #e03131)' : 'var(--color-accent)';
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-2xl border ${big ? 'px-5 py-2.5' : 'px-3 py-1'}`}
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
    >
      <MltCoin variant={big ? 'full' : 'simple'} size={big ? 32 : 18} title={currencyName} />
      <span className={`font-extrabold tabular-nums ${big ? 'text-3xl' : 'text-xl'}`} style={{ color }}>{balance.toLocaleString('ru-RU')}</span>
      <span className={`font-semibold text-[var(--color-text-muted)] ${big ? 'text-sm' : 'text-xs'}`}>{currencyName}</span>
    </span>
  );
}

export function RubPill({ balance, big = false }: { balance: number; big?: boolean }) {
  const neg = balance < 0;
  const color = neg ? 'var(--color-negative, #e03131)' : 'var(--color-positive, #2f9e44)';
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-2xl border ${big ? 'px-5 py-2.5' : 'px-3 py-1'}`}
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }}
      title="Рублёвый кошелёк: денежные бонусы; можно обменять на MLT или вывести в ЗП"
    >
      <span className={`font-extrabold tabular-nums ${big ? 'text-3xl' : 'text-xl'}`} style={{ color }}>{balance.toLocaleString('ru-RU')}</span>
      <span className={`font-semibold text-[var(--color-text-muted)] ${big ? 'text-sm' : 'text-xs'}`}>₽</span>
    </span>
  );
}

// Блок денег в шапке ЛК (макет Glass2, ui_kits/monolitika/profile.html): «сункен»-
// строка на всю ширину карточки — две половины с подписями и вертикальным
// разделителем, вместо двух пилюль по краю. Отрицательный баланс (ручные штрафы)
// красным — то же правило, что в RubPill/BalancePill, которые остались для
// кошелька/магазина/инвентаря, где нужен именно компактный вид.
function MoneyRow({ rub, mlt, currencyName }: { rub: number; mlt: number; currencyName: string }) {
  const rubColor = rub < 0 ? 'var(--color-negative, #e03131)' : 'var(--color-positive, #2f9e44)';
  const mltColor = mlt < 0 ? 'var(--color-negative, #e03131)' : 'var(--color-accent)';
  return (
    <div className="flex w-full items-stretch justify-between gap-3 rounded-2xl bg-[var(--color-bg-hover)] px-4 py-3">
      <div className="flex min-w-0 flex-col items-start gap-0.5"
        title="Рублёвый кошелёк: денежные бонусы; можно обменять на MLT или вывести в ЗП">
        <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">Рублёвый счёт</span>
        <span className="text-xl font-extrabold tabular-nums" style={{ color: rubColor }}>
          {rub.toLocaleString('ru-RU')} <span className="text-sm font-semibold text-[var(--color-text-muted)]">₽</span>
        </span>
      </div>
      <div className="w-px shrink-0 self-stretch bg-[var(--color-border)]" />
      <div className="flex min-w-0 flex-col items-end gap-0.5">
        <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">Баланс {currencyName}</span>
        <span className="flex items-baseline gap-1.5">
          <MltCoin variant="full" size={22} title={currencyName} />
          <span className="text-xl font-extrabold tabular-nums" style={{ color: mltColor }}>{mlt.toLocaleString('ru-RU')}</span>
        </span>
      </div>
    </div>
  );
}

// Плашка TTL MLT (31.07): «сгорит N через X дней» — живые FIFO-остатки
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
  // Подтверждение — вместо window.confirm (задача 2764): compute сам текст и
  // body заранее, дальше — ConfirmDialog, submit.mutate запускается из onConfirm.
  const [pendingConfirm, setPendingConfirm] = useState<{ text: string; body: Record<string, unknown> } | null>(null);
  const currency = ctx.currencyName ?? 'MLT';
  const selType = ctx.penaltyTypes?.find(t => t.id === typeId) ?? null;

  // Ручное поощрение/штраф — актор двигает ЧУЖОЙ кошелёк: пин ВСЕГДА (спека §3,
  // задача #2995/#3020). lastBody хранит тело последней попытки, чтобы дослать
  // его же с полем pin после установки/ввода пина.
  const [lastBody, setLastBody] = useState<Record<string, unknown> | null>(null);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [pinVerifyOpen, setPinVerifyOpen] = useState(false);

  const submit = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const r = await fetchPinGated('/api/badges/manual', 'POST', body);
      if (r.ok) return { done: true } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: true } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: true } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) { onDone(); return; }
      if (res.needsSetup) setPinSetupOpen(true);
      if (res.needsVerify) setPinVerifyOpen(true);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  // Валидация + текст подтверждения — раньше жили внутри mutationFn (throw →
  // onError), теперь считаются на клик «Поощрить»/«Оштрафовать»: ошибка сразу
  // в error-стейт, успех — открывает ConfirmDialog вместо window.confirm.
  function requestConfirm() {
    setError(null);
    if (kind === 'bonus') {
      const v = Number(amount);
      if (!Number.isInteger(v) || v <= 0) return setError('Сумма — целое число больше нуля');
      if (!comment.trim()) return setError('Комментарий обязателен');
      setPendingConfirm({
        text: `Поощрить ${managerName} на ${v} ${currency}?\n\nКомментарий: ${comment.trim()}`,
        body: { bitrixId: Number(managerId), type: 'bonus', amount: v, comment: comment.trim() },
      });
    } else {
      if (!selType) return setError('Выберите причину штрафа');
      // Текст подтверждения с РАССЧИТАННОЙ суммой (для percent — от текущего баланса)
      setPendingConfirm({
        text: `Оштрафовать ${managerName} на ${selType.computedAmount} ${currency}` +
          (selType.priceMode === 'percent' ? ` (${selType.price}% от баланса ${ctx.balance ?? 0})` : '') +
          `?\n\nПричина: ${selType.name}${comment.trim() ? `\nКомментарий: ${comment.trim()}` : ''}`,
        body: { bitrixId: Number(managerId), type: 'penalty', penaltyTypeId: selType.id, comment: comment.trim() },
      });
    }
  }

  return (
    // Modal вместо самописного fixed inset-0 (задача 2764, правило 3 CLAUDE.md).
    // Прячем это окно (не размонтируем — стейт/мутация живы), пока открыт
    // PinSetupDialog/PinDialog поверх него: иначе два модала складываются
    // в стопку (живая находка при тестировании задачи #3020). onOpenChange
    // защищён тем же условием — иначе Radix закрывает родителя вместе с
    // собой и PinDialog размонтируется, не успев отрисоваться (тоже поймано
    // живьём).
    <Modal
      open={!pinSetupOpen && !pinVerifyOpen}
      onOpenChange={(o) => { if (!o && !pinSetupOpen && !pinVerifyOpen) onClose(); }}
      title={`${kind === 'bonus' ? 'Поощрить' : 'Оштрафовать'}: ${managerName}`} desktopWidth="sm:max-w-md">
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
              onClick={requestConfirm}
              className={`rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${kind === 'bonus' ? 'bg-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-negative,#e03131)]'}`}>
              {submit.isPending ? 'Сохранение…' : kind === 'bonus' ? 'Поощрить' : 'Оштрафовать'}
            </button>
          </div>
        </div>
      <ConfirmDialog
        open={!!pendingConfirm}
        title={kind === 'bonus' ? 'Подтвердите поощрение' : 'Подтвердите штраф'}
        description={pendingConfirm?.text ?? ''}
        confirmLabel={kind === 'bonus' ? 'Поощрить' : 'Оштрафовать'}
        tone={kind === 'bonus' ? 'default' : 'danger'}
        pending={submit.isPending}
        onConfirm={() => { if (pendingConfirm) { const body = pendingConfirm.body; setPendingConfirm(null); setLastBody(body); submit.mutate(body); } }}
        onCancel={() => setPendingConfirm(null)}
      />
      <PinSetupDialog
        open={pinSetupOpen}
        onOpenChange={setPinSetupOpen}
        onSuccess={() => { setPinSetupOpen(false); if (lastBody) submit.mutate(lastBody); }}
      />
      <PinDialog
        open={pinVerifyOpen}
        onOpenChange={setPinVerifyOpen}
        title={kind === 'bonus' ? 'Подтвердите поощрение пином' : 'Подтвердите штраф пином'}
        onConfirm={async (pin) => {
          if (!lastBody) return { ok: false, error: 'Нет операции' };
          const r = await fetchPinGated('/api/badges/manual', 'POST', { ...lastBody, pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyOpen(false);
          onDone();
          return { ok: true };
        }}
      />
    </Modal>
  );
}

// ── Таб «Профиль»: сводка ────────────────────────────────────────────────────

export function ProfileTab({ managerId, isSelf, card, onGoRewards, forceReadOnly = false }: {
  managerId: string;
  isSelf: boolean;
  card: ManagerCardResult | undefined;
  onGoRewards: () => void;
  /** Задача 2771: список сотрудников для admin/director+ ведёт сюда с этим
   *  флагом — прячет «Ручные операции» даже там, где сервер их бы разрешил
   *  (canManualFor). Существующий путь «Моя команда» его не ставит. */
  forceReadOnly?: boolean;
}) {
  const qc = useQueryClient();
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  const { data: extra } = useProfileExtra(managerId, isSelf);
  const { data: planFact } = usePlanFact(managerId, 'manager');
  // Ручные операции: контекст только в чужой карточке (себя поощрять нельзя,
  // сервер это же и отбивает — canManual=false в своём ЛК у не-админов).
  // forceReadOnly — даже не запрашиваем контекст, не только прячем кнопки.
  const { data: manualCtx } = useManualContext(managerId, !isSelf && !forceReadOnly);
  const [manualKind, setManualKind] = useState<'bonus' | 'penalty' | null>(null);
  // Пикер обложки (ЛК-соцсетка этап 2) — только в собственном ЛК.
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
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
    <>
    {/* Раскладка по макету Glass2 (ui_kits/monolitika/profile.html): ЦЕНТРИРОВАННАЯ
        сетка 380px + 1fr, а не растяжка на всю ширину. Прежнее «ширина резиновая,
        без max-w» было правкой владельца от 10.07 — 04.08 он её ОТМЕНИЛ («это
        уебищно, делать надо красиво»), поэтому здесь max-w + mx-auto.
        lg: — две колонки; ниже (планшет/телефон) колонки складываются в одну,
        порядок сохраняется: личность → рейтинг → месяц → уровень → награды.
        minmax(0,1fr) у правой колонки обязателен: без него широкий контент внутри
        (таблицы наград, длинные имена классов XP) распирал бы сетку вместо
        переноса/скролла — тот же класс бага, что чинили в задаче 2779. */}
    <div className="mx-auto grid w-full max-w-[1360px] items-start gap-4 sm:gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">

      {/* ══ ЛЕВАЯ КОЛОНКА: кто это ══ */}
      <div className="flex min-w-0 flex-col gap-4 sm:gap-5">
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden">
        {/* Обложка (ЛК-соцсетка этап 2): генеративный CSS-паттерн из каталога.
            Вёрстка — классика Facebook/VK (правка владельца 05.08 по скрину
            «перекрывает аватарку»): аватар наезжает на НИЖНЮЮ кромку обложки
            ровно наполовину, с кольцом цвета карточки (ring отделяет фото от
            паттерна). Пропорции выправлены: обложка выше (9rem/11rem), аватар
            160px вместо прежних 220 — раньше обложка выглядела приклеенной
            полоской за гигантским фото. Кнопка смены — низ-право обложки, как
            «Изменить обложку» в FB; только у владельца профиля. */}
        <div className="relative h-36 sm:h-44 w-full" style={coverStyle(extra?.coverId)}>
          {isSelf && !forceReadOnly && (
            /* Позиционирует ОБЁРТКА, а не сама кнопка (живой баг со скрина
               владельца: кнопка оказывалась в левом верхнем углу): .tap-target
               задаёт position:relative и, идя в globals.css ПОЗЖЕ утилит
               Tailwind, молча перебивает .absolute — кнопка выпадала в поток.
               Обёртке tap-target не нужен, кнопке внутри — нужен (зона 44px). */
            <div className="absolute right-2 bottom-2">
              <button
                onClick={() => setCoverPickerOpen(true)}
                className="tap-target inline-flex items-center gap-1.5 rounded-lg bg-black/35 px-2 py-1 text-[11px] font-semibold text-white backdrop-blur-sm hover:bg-black/50 transition-colors"
                title="Сменить обложку"
              >
                <Camera size={13} /> Обложка
              </button>
            </div>
          )}
        </div>
        {isSelf && !forceReadOnly && <CoverPicker open={coverPickerOpen} onOpenChange={setCoverPickerOpen} />}
        {/* relative ОБЯЗАТЕЛЕН (живой баг со скрина владельца): обложка выше —
            position:relative и по правилам stacking-порядка рисуется ПОВЕРХ
            непозиционированного соседа; без relative здесь паттерн обложки
            перекрывал верх аватара. */}
        <div className="relative px-4 sm:px-5 pb-5 -mt-20">
        <div className="flex flex-col items-center gap-3.5 text-center">
          {/* Радиус обёртки РАВЕН радиусу Avatar (size×0.11 ≈ 18px), не больше:
              ring — это box-shadow, он сам рисуется снаружи и сам добавляет свои
              +4px к радиусу. Прежний rounded-[22px] давал белые клинья в углах
              (скрин владельца: «скругления рамки не повторяют аватар»). */}
          <div className="rounded-[18px] ring-4 ring-[var(--color-bg-surface)] shadow-md">
            <Avatar name={card?.profile.name ?? '?'} url={card?.profile.avatarUrl} size={160} shape="rounded" />
          </div>
          <div className="min-w-0 w-full">
            {/* Правка владельца 05.08: чип уровня НЕ должен липнуть ко второй
                строке ФИО. flex-wrap даёт ровно нужное поведение: имя — ОДИН
                flex-элемент (внутри переносится само), чип — второй; пока имя
                в одну строку — чип рядом, имя в две — элемент имени занимает
                всю ширину и чип уезжает на отдельную (третью) строку. */}
            <h2 className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-2xl font-extrabold leading-tight text-[var(--color-text)]">
              <span className="min-w-0">{card?.profile.name ?? '…'}</span>
              {extra?.xp && extra.xp.level > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-accent)]"
                  title={`Уровень ${extra.xp.level} — ${extra.xp.title}${extra.xp.topClass ? ` · топ-класс: ${extra.xp.topClass.name} ${extra.xp.topClass.level} ур.` : ''}`}>
                  {extra.xp.level} ур.{extra.xp.topClass ? ` · ${extra.xp.topClass.name}` : ''}
                </span>
              )}
            </h2>
            <div className="mt-1.5 text-[13px] text-[var(--color-text-muted)] flex items-center justify-center gap-2 flex-wrap">
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
          {/* Баланс/действия — задача 2778 (скрин владельца с iPhone, 375px):
              блок был БЕЗ ограничителя ширины, а средняя колонка (имя/отдел/стаж)
              — min-w-0 flex-1 (может сжиматься до нуля). Итог: flex-wrap на
              родителе никогда не срабатывал — браузер предпочитал сжать среднюю
              колонку в нитку, а не перенести этот блок на новую строку, плашка
              баланса налезала поверх текста. Тот же приём, что уже есть в hero
              ManagerCardPage.tsx (комментарий «на узком экране... содержимое
              этого блока... с shrink-0 и без переноса оно уезжало за край»):
              w-full на мобильном заставляет блок занять всю строку целиком —
              с flex-wrap на родителе это и есть перенос на новую строку; с sm —
              прежнее поведение (нерастяжимая группа справа). */}
          <div className="flex w-full flex-col items-center gap-2.5">
            {/* Деньги — «сункен»-строка из макета: две половины с подписями и
                разделителем, вместо двух пилюль. Рублёвый баланс виден ВСЕГДА,
                включая 0 (правка владельца 02.08: «если 0 пусть будет 0» —
                раньше плашка пряталась целиком при balance===0, и казалось, что
                кошелька нет вовсе). Пилюли RubPill/BalancePill не удалены — они
                по-прежнему используются в кошельке, магазине и инвентаре. */}
            <MoneyRow
              rub={extra?.rubBalance ?? 0}
              mlt={shelfData?.balance ?? 0}
              currencyName={shelfData?.currencyName ?? 'MLT'}
            />
            <ExpiringPill expiring={extra?.expiring} currencyName={shelfData?.currencyName ?? 'MLT'} />
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
        </div>{/* /обёртка контента под обложкой (-mt-14) */}
      </section>

      {/* Место в рейтинге — отдельная карточка чипами (макет: лесенка отдел →
          департамент → филиал → страна под карточкой личности, а не строкой). */}
      {(card?.ranks?.length ?? 0) > 0 && (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
          <div className="mb-2.5 flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Место в рейтинге</span>
            {card?.rating.value != null && (
              <span className="text-[13px] whitespace-nowrap">
                <span className="text-[var(--color-text-muted)]">рейтинг </span>
                <b className="text-[var(--color-text)] tabular-nums">{card.rating.value.toFixed(1)}</b>
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {card!.ranks!.map(r => (
              <span key={r.key}
                className="inline-flex items-baseline gap-1.5 self-start rounded-full bg-[var(--color-accent-soft)] px-3.5 py-1.5 text-[13px] tabular-nums">
                <b className="font-bold text-[var(--color-accent)]">{r.rank ? `#${r.rank}` : '—'}</b>
                <span className="text-[var(--color-text-muted)]">из {r.size} {r.label}</span>
              </span>
            ))}
          </div>
        </section>
      )}
      </div>

      {/* ══ ПРАВАЯ КОЛОНКА: цифры ══ */}
      <div className="flex min-w-0 flex-col gap-4 sm:gap-5">

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

      {/* XP: уровень, полоса до следующего уровня, классы (01.08, миграция 124) */}
      {extra?.xp && (
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-extrabold tabular-nums text-[var(--color-accent)]">{extra.xp.level}</span>
              <span className="text-sm font-bold text-[var(--color-text)]">уровень · {extra.xp.title}</span>
            </div>
            <div className="min-w-[220px] flex-1">
              {(() => {
                const span = extra.xp!.nextLevelXp - extra.xp!.currentLevelXp;
                const into = extra.xp!.totalXp - extra.xp!.currentLevelXp;
                const pct = span > 0 ? Math.min(100, Math.round((into / span) * 100)) : 100;
                return (
                  <div title={`Всего ${extra.xp!.totalXp.toLocaleString('ru-RU')} XP. XP — репутация: только растёт, на MLT не меняется.`}>
                    <div className="mb-1 flex justify-between text-[11px] text-[var(--color-text-muted)]">
                      <span>до уровня {extra.xp!.level + 1} — {(extra.xp!.nextLevelXp - extra.xp!.totalXp).toLocaleString('ru-RU')} XP</span>
                      <span className="tabular-nums">{extra.xp!.totalXp.toLocaleString('ru-RU')} XP</span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--color-bg-hover)]">
                      <div className="h-2 rounded-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
          {extra.xp.classes.length > 0 && (
            <div className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {extra.xp.classes.map(c => (
                <div key={c.name} className="flex items-center gap-2 text-[13px]">
                  <span className="w-32 truncate font-semibold text-[var(--color-text)]" title={c.name}>{c.name}</span>
                  <span className="w-12 text-right tabular-nums font-bold text-[var(--color-accent)]">{c.level} ур.</span>
                  <div className="h-1.5 flex-1 rounded-full bg-[var(--color-bg-hover)]" title={`${c.xp.toLocaleString('ru-RU')} XP · до следующего уровня ${c.progress}%`}>
                    <div className="h-1.5 rounded-full bg-[var(--color-accent)] opacity-70" style={{ width: `${Math.max(c.progress, 3)}%` }} />
                  </div>
                  <span className="w-20 text-right text-[11px] tabular-nums text-[var(--color-text-muted)]">{c.xp.toLocaleString('ru-RU')} XP</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

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
        {/* Сетка наград — 2 в ряд, как в макете (было 4): в правой колонке сетки
            380+1fr четыре карточки сжимались до ~90px и обрезали названия наград
            на первом слове. */}
        {recent.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">Наград пока нет — всё впереди!</div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {recent.map(item => <BadgeCard key={item.key} item={item} />)}
          </div>
        )}
      </section>

      {/* Лента событий (этап 2, 05.08): награды/квесты/крупные продажи постами,
          «чтоб профиль был живым». Правая колонка, под наградами. */}
      <ProfileFeed managerId={managerId} />
      </div>
    </div>
    </>
  );
}

// ── Таб «Награды»: полная полка + история начислений ─────────────────────────

// Описание строки выписки: авто — награда; ручные — кем и за что; сторно — «отмена…».
export function ledgerTitle(r: LedgerRow): { title: string; sub: string | null } {
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
  if (r.source === 'expiry') return { title: r.comment ?? 'Сгорание MLT (истёк срок жизни)', sub: null };
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
              −{t.priceMode === 'percent' ? `${t.price}% от баланса` : `${t.price} ${data?.currencyName ?? 'MLT'}`}
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

export function RubWalletBlock({ managerId, isSelf, extra, currencyName }: {
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

  // Рубли — пин ВСЕГДА, вне зависимости от порога (спека §3, задача #2995).
  const [pinSetupFor, setPinSetupFor] = useState<{ kind: 'convert' | 'payout'; v: number } | null>(null);
  const [pinVerifyFor, setPinVerifyFor] = useState<{ kind: 'convert' | 'payout'; v: number } | null>(null);

  const convert = useMutation({
    mutationFn: async (v: number) => {
      const r = await fetchPinGated('/api/badges/convert', 'POST', { amount: v });
      if (r.ok) return { done: true } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: v } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: v } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) { setError(null); refresh(); return; }
      if (res.needsSetup !== undefined) setPinSetupFor({ kind: 'convert', v: res.needsSetup });
      if (res.needsVerify !== undefined) setPinVerifyFor({ kind: 'convert', v: res.needsVerify });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const payout = useMutation({
    mutationFn: async (v: number) => {
      const r = await fetchPinGated('/api/badges/payout', 'POST', { amount: v });
      if (r.ok) return { done: true } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: v } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: v } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) { setError(null); refresh(); return; }
      if (res.needsSetup !== undefined) setPinSetupFor({ kind: 'payout', v: res.needsSetup });
      if (res.needsVerify !== undefined) setPinVerifyFor({ kind: 'payout', v: res.needsVerify });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  // Ввод суммы + подтверждение — вместо window.prompt+window.confirm (задача
  // 2764): двухшаговый диалог (сумма → расчёт/подтверждение), обе кнопки ведут
  // сюда с разным kind, текст и мутация выбираются по нему.
  const [amountDialog, setAmountDialog] = useState<'convert' | 'payout' | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<{ kind: 'convert' | 'payout'; v: number; text: string } | null>(null);

  function openAmountDialog(kind: 'convert' | 'payout') {
    setAmountInput('');
    setAmountError(null);
    setAmountDialog(kind);
  }
  function submitAmount() {
    const v = Number(amountInput);
    if (!Number.isInteger(v) || v <= 0) return setAmountError('Сумма — целое число больше нуля');
    const kind = amountDialog!;
    setAmountDialog(null);
    setPendingConfirm({
      kind, v,
      text: kind === 'convert'
        ? `Обменять ${v} ₽ на ${Math.round(v * rate)} ${currencyName}? Обратной конвертации нет.`
        : `Подать заявку на вывод ${v} ₽ в зарплату? Выплату подтверждает руководитель.`,
    });
  }

  const requests = payouts?.requests ?? [];
  // Раньше секция целиком пряталась у чужой карточки с нулевым рублёвым
  // балансом — правка владельца 02.08 («если 0 пусть будет 0») отменяет это:
  // кошелёк виден всегда, просто с 0 ₽ и неактивными кнопками действий
  // (уже была своя защита disabled={... || rub <= 0} на самих кнопках).

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-[var(--color-text)]">Рублёвый кошелёк</h2>
        <RubPill balance={rub} />
        {isSelf && (
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" onClick={() => openAmountDialog('convert')} disabled={convert.isPending || rub <= 0}
              className="rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:opacity-40">
              Обменять на {currencyName}
            </button>
            <button type="button" onClick={() => openAmountDialog('payout')} disabled={payout.isPending || rub <= 0}
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
      <Modal
        open={!!amountDialog}
        onOpenChange={(o) => { if (!o) setAmountDialog(null); }}
        title={amountDialog === 'convert' ? `Обменять на ${currencyName}` : 'Вывести в ЗП'}
        desktopWidth="sm:max-w-xs"
      >
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Сумма, ₽ {amountDialog === 'convert'
            ? `(курс 1 ₽ = ${rate} ${currencyName}, доступно ${rub} ₽)`
            : `(доступно ${rub} ₽)`}
          <input
            autoFocus type="number" inputMode="numeric" value={amountInput}
            onChange={e => setAmountInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitAmount(); }}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-base sm:text-sm text-right tabular-nums"
            placeholder="1000"
          />
        </label>
        {amountError && <div className="mt-1.5 text-xs text-[var(--color-negative,#e03131)]">{amountError}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setAmountDialog(null)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" onClick={submitAmount} className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white">Далее</button>
        </div>
      </Modal>
      <ConfirmDialog
        open={!!pendingConfirm}
        title={pendingConfirm?.kind === 'convert' ? 'Подтвердите обмен' : 'Подтвердите заявку на вывод'}
        description={pendingConfirm?.text ?? ''}
        confirmLabel={pendingConfirm?.kind === 'convert' ? 'Обменять' : 'Подать заявку'}
        pending={convert.isPending || payout.isPending}
        onConfirm={() => {
          if (!pendingConfirm) return;
          const { kind, v } = pendingConfirm;
          setPendingConfirm(null);
          if (kind === 'convert') convert.mutate(v); else payout.mutate(v);
        }}
        onCancel={() => setPendingConfirm(null)}
      />
      <PinSetupDialog
        open={!!pinSetupFor}
        onOpenChange={(o) => { if (!o) setPinSetupFor(null); }}
        onSuccess={() => {
          const f = pinSetupFor; setPinSetupFor(null);
          if (f) (f.kind === 'convert' ? convert : payout).mutate(f.v);
        }}
      />
      <PinDialog
        open={!!pinVerifyFor}
        onOpenChange={(o) => { if (!o) setPinVerifyFor(null); }}
        title={pinVerifyFor?.kind === 'convert' ? 'Подтвердите обмен пином' : 'Подтвердите заявку на вывод пином'}
        description={pinVerifyFor ? `${pinVerifyFor.v.toLocaleString('ru-RU')} ₽` : undefined}
        onConfirm={async (pin) => {
          if (!pinVerifyFor) return { ok: false, error: 'Нет операции' };
          const { kind, v } = pinVerifyFor;
          const url = kind === 'convert' ? '/api/badges/convert' : '/api/badges/payout';
          const r = await fetchPinGated(url, 'POST', { amount: v, pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyFor(null);
          setError(null);
          refresh();
          return { ok: true };
        }}
      />
    </section>
  );
}

// «Награды» после выноса финансов в «Кошелёк» (правка владельца 05.08:
// «мы оставили функционал кошелька в разделе награды? убери») — только полка.
// Полный редизайн в ачивки (редкость/блеклые/конструктор) — отдельная задача.
export function RewardsTab({ managerId, isSelf }: { managerId: string; isSelf: boolean; forceReadOnly?: boolean }) {
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <BadgeShelf managerId={isSelf ? undefined : managerId} />
    </div>
  );
}

// Выписка со сторно-механикой и справочником штрафов — жила в «Наградах»,
// с 05.08 рендерится «Кошельком» (features/wallet/ui/WalletTab.tsx).
export function LedgerSection({ managerId, isSelf, forceReadOnly = false }: { managerId: string; isSelf: boolean; forceReadOnly?: boolean }) {
  const qc = useQueryClient();
  const { data: shelfData } = useShelfQuery(isSelf ? undefined : managerId);
  const { data: extra, isLoading } = useProfileExtra(managerId, isSelf);
  // forceReadOnly (задача 2771) — прячет и «сторно» тем же способом, что
  // ProfileTab прячет поощрить/оштрафовать: контекст просто не запрашивается.
  const { data: manualCtx } = useManualContext(managerId, !isSelf && !forceReadOnly);
  const currencyName = shelfData?.currencyName ?? 'MLT';
  const ledger = extra?.ledger ?? [];
  // Подтверждение сторно — вместо window.confirm (задача 2764).
  const [reverseConfirmId, setReverseConfirmId] = useState<number | null>(null);
  const [reverseError, setReverseError] = useState<string | null>(null);
  // Сторно — пин ВСЕГДА (спека §3, задача #2995/#3020).
  const [reversePinSetupId, setReversePinSetupId] = useState<number | null>(null);
  const [reversePinVerifyId, setReversePinVerifyId] = useState<number | null>(null);

  const reverseRefresh = () => {
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
    void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
    void qc.invalidateQueries({ queryKey: ['badges-manual-ctx'] });
  };

  // Сторно (только админ): компенсирующая запись, история сохраняется.
  const reverse = useMutation({
    mutationFn: async (ledgerId: number) => {
      const r = await fetchPinGated('/api/badges/manual/reverse', 'POST', { ledgerId });
      if (r.ok) return { done: true } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: ledgerId } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: ledgerId } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) { setReverseError(null); reverseRefresh(); return; }
      if (res.needsSetup !== undefined) setReversePinSetupId(res.needsSetup);
      if (res.needsVerify !== undefined) setReversePinVerifyId(res.needsVerify);
    },
    onError: (e) => setReverseError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">Выписка</h2>
          <span className="text-xs text-[var(--color-text-muted)]">награды, поощрения и штрафы</span>
          {ledger.length > 0 && <span className="text-xs text-[var(--color-text-muted)]">{ledger.length}</span>}
          {reverseError && <span className="text-xs text-[var(--color-negative,#e03131)]">{reverseError}</span>}
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
                            onClick={() => setReverseConfirmId(r.id)}
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
      <ConfirmDialog
        open={reverseConfirmId !== null}
        title="Сторнировать операцию?"
        description="Появится компенсирующая запись, история сохраняется."
        confirmLabel="Сторнировать"
        tone="danger"
        pending={reverse.isPending}
        onConfirm={() => { if (reverseConfirmId !== null) { reverse.mutate(reverseConfirmId); setReverseConfirmId(null); } }}
        onCancel={() => setReverseConfirmId(null)}
      />
      <PinSetupDialog
        open={reversePinSetupId !== null}
        onOpenChange={(o) => { if (!o) setReversePinSetupId(null); }}
        onSuccess={() => { const id = reversePinSetupId; setReversePinSetupId(null); if (id !== null) reverse.mutate(id); }}
      />
      <PinDialog
        open={reversePinVerifyId !== null}
        onOpenChange={(o) => { if (!o) setReversePinVerifyId(null); }}
        title="Подтвердите сторно пином"
        onConfirm={async (pin) => {
          if (reversePinVerifyId === null) return { ok: false, error: 'Нет операции' };
          const r = await fetchPinGated('/api/badges/manual/reverse', 'POST', { ledgerId: reversePinVerifyId, pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setReversePinVerifyId(null);
          setReverseError(null);
          reverseRefresh();
          return { ok: true };
        }}
      />
    </div>
  );
}

// ── Магазин и инвентарь (MVP 31.07 + пакет переводов/подарков) ───────────────
// Данные общие (/api/shop): витрина — таб «Магазин», предметы — таб «Инвентарь».

interface ShopItemView {
  id: number; name: string; description: string | null; category: 'material' | 'immaterial' | 'boost';
  emoji: string; priceEball: number;
  stock: number | null; ttlMonths: number;
  minLevel: number; marketplaceUrl: string | null; buyerScope: 'all' | 'rop_only';
  perPersonLimit: number | null; perPersonLimitDays: number | null; purchasedByViewer: number;
  requiresApproval: boolean;
  boostMetric: string | null; boostMultiplier: number | null; boostWindowDays: number | null; boostScope: string | null;
  rarityKey: string; rarityLabel: string; rarityColor: string;
  hasImage: boolean;
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
  currencyName: string; balance: number; rubBalance: number; viewerLevel: number; viewerIsRop: boolean;
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
  { key: 'boost', label: 'Бусты' },
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
  const currencyName = data?.currencyName ?? 'MLT';
  const viewerLevel = data?.viewerLevel ?? 0;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shop'] });
    void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  // Подтверждение покупки — вместо window.confirm (задача 2764). MLT — единственная
  // валюта (правка владельца «продаётся только в MLT»), рублёвой ветки больше нет.
  const [pendingBuy, setPendingBuy] = useState<{ item: ShopItemView; text: string } | null>(null);
  function requestBuy(item: ShopItemView) {
    const price = item.priceEball;
    const balance = data?.balance ?? 0;
    setPendingBuy({
      item,
      text: `Купить «${item.name}» за ${price.toLocaleString('ru-RU')} ${currencyName}?\n\n` +
        `Останется: ${(balance - price).toLocaleString('ru-RU')} ${currencyName}. ` +
        `Предмет попадёт в инвентарь, срок годности ${item.ttlMonths} мес.`,
    });
  }

  // Пин по личному порогу (задача #2995): первый запрос без пина; если бэк
  // просит пин — открываем PinSetupDialog (пин ещё не заведён) либо PinDialog
  // (пин есть, нужен ввод/повтор) и досылаем ту же покупку с полем pin.
  const [pinSetupItem, setPinSetupItem] = useState<ShopItemView | null>(null);
  const [pinVerifyItem, setPinVerifyItem] = useState<ShopItemView | null>(null);

  const buy = useMutation({
    mutationFn: async (item: ShopItemView) => {
      const r = await fetchPinGated('/api/shop', 'POST', { itemId: item.id });
      if (r.ok) return { done: true } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: item } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: item } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) { setError(null); refresh(); return; }
      if (res.needsSetup) setPinSetupItem(res.needsSetup);
      if (res.needsVerify) setPinVerifyItem(res.needsVerify);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const items = data?.items ?? [];
  const activeCount = (data?.inventory ?? []).filter(i => i.status === 'owned' || i.status === 'activation_requested').length;

  // «Магазин руководителя» (решение владельца 05.08): rop_only-позиции (награды
  // для отдела, бустеры) — ОТДЕЛЬНАЯ витрина табом внутри магазина, а не вперемешку
  // с личными. Сервер отдаёт rop_only только РОПу/директору (см. /api/shop), поэтому
  // у рядового менеджера переключателя просто нет — есть только «свой» магазин.
  const [shopScope, setShopScope] = useState<'personal' | 'leader'>('personal');
  const leaderItems = items.filter(i => i.buyerScope === 'rop_only');
  const hasLeaderShop = leaderItems.length > 0;
  const shownItems = hasLeaderShop && shopScope === 'leader'
    ? leaderItems
    : items.filter(i => i.buyerScope !== 'rop_only');

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <BalancePill balance={data?.balance ?? 0} currencyName={currencyName} />
        {/* Всегда виден, включая 0 (правка владельца 02.08) — см. ProfileTab. */}
        <RubPill balance={data?.rubBalance ?? 0} />
        {onGoInventory && (
          <button type="button" onClick={onGoInventory}
            className="ml-auto text-xs font-semibold text-[var(--color-accent)] hover:underline">
            🎒 Мой инвентарь{activeCount > 0 ? ` (${activeCount})` : ''} →
          </button>
        )}
        {error && <span className="text-xs text-[var(--color-negative,#e03131)]">{error}</span>}
      </div>

      {/* Переключатель витрин — только когда руководительская витрина непуста
          (у рядового менеджера сервер rop_only не отдаёт — переключателя нет). */}
      {hasLeaderShop && (
        <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs self-start">
          {([['personal', 'Для себя'], ['leader', 'Магазин руководителя']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setShopScope(key)}
              className={`px-3 min-h-11 transition-colors whitespace-nowrap ${
                shopScope === key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Гача уехала из магазина в собственный раздел «Колесо фортуны»
          (правка владельца 05.08) — см. вкладку wheel в ManagerCardPage. */}

      {/* Витрина по типам (материальные/нематериальные/бусты) — «командные»
          позиции с 05.08 снова отдельная витрина (таб «Магазин руководителя»
          выше), внутри неё та же группировка по типам. */}
      {SHOP_CATEGORIES.map(cat => {
        const catItems = shownItems.filter(i => i.category === cat.key);
        if (catItems.length === 0) return null;
        return (
          <section key={cat.key} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
            <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{cat.label}</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {catItems.map(item => {
                const soldOut = item.stock !== null && item.stock <= 0;
                const canAfford = (data?.balance ?? 0) >= item.priceEball;
                const levelOk = viewerLevel >= item.minLevel;
                // Ниже порога доступности карточка блюрится (задача 2983,
                // предложение владельца) — контент (эмодзи/название/описание/
                // ссылка) скрыт под blur, цена и требование по уровню ОСТАЮТСЯ
                // читаемыми (не блюрим карточку «в кашу»). Кнопка покупки
                // неактивна — та же проверка levelOk, что и гейт на бэкенде
                // (POST /api/shop блокирует покупку ниже min_level независимо
                // от UI).
                const locked = !levelOk;
                const limitReached = item.perPersonLimit !== null && item.purchasedByViewer >= item.perPersonLimit;
                const canBuy = !soldOut && canAfford && levelOk && !limitReached;
                let blockedReason: string | null = null;
                if (soldOut) blockedReason = 'Позиция закончилась';
                else if (locked) blockedReason = `Доступно с ${item.minLevel} уровня (у вас ${viewerLevel})`;
                else if (limitReached) blockedReason = `Лимит покупок исчерпан (${item.perPersonLimit}${item.perPersonLimitDays ? ` за ${item.perPersonLimitDays} дн.` : ''})`;
                else if (!canAfford) blockedReason = `Не хватает ${currencyName}`;
                return (
                  <div key={item.id}
                    className="flex flex-col gap-1.5 rounded-xl border px-3.5 py-3"
                    style={{ borderColor: item.rarityKey === 'common' ? 'var(--color-border)' : `${item.rarityColor}66` }}
                  >
                    <div className="relative overflow-hidden rounded-lg">
                      <div className={locked ? 'pointer-events-none select-none blur-[5px]' : undefined}>
                        <div className="flex items-start gap-2">
                          {/* Своя картинка (задача 2994), если задана — иначе эмодзи вместо фото. */}
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--color-bg)] text-2xl">
                            {item.hasImage
                              ? <img src={`/api/shop-item-image/${item.id}`} alt="" className="h-full w-full object-cover" />
                              : item.emoji}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-[var(--color-text)] text-[14px]">{item.name}</div>
                            <span
                              className="mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                              style={{ color: item.rarityColor, backgroundColor: `${item.rarityColor}1a` }}
                            >
                              {item.rarityLabel}
                            </span>
                          </div>
                        </div>
                        {item.description && <div className="mt-1.5 text-xs text-[var(--color-text-muted)]">{item.description}</div>}
                        {item.marketplaceUrl && (
                          <a href={item.marketplaceUrl} target="_blank" rel="noopener noreferrer" tabIndex={locked ? -1 : undefined}
                            className="mt-1.5 inline-block text-[11px] text-[var(--color-accent)] hover:underline">
                            Пример на маркетплейсе ↗
                          </a>
                        )}
                      </div>
                      {/* Оверлей поверх заблюренного контента — сама подпись НЕ
                          блюрится, читается чётко (задача 2983). */}
                      {locked && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-3 text-center">
                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-text)] shadow-lg">
                            <Lock size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                            Доступен с {item.minLevel} уровня
                          </span>
                        </div>
                      )}
                    </div>
                    {/* Цена и требование по уровню — ВСЕГДА читаемы, не блюрятся. */}
                    <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                      <span className="inline-flex items-center gap-1 font-extrabold tabular-nums text-[var(--color-accent)]">
                        <MltCoin variant="full" size={20} title={currencyName} />
                        {item.priceEball.toLocaleString('ru-RU')} <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">{currencyName}</span>
                      </span>
                      {item.stock !== null && (
                        <span className="text-[11px] text-[var(--color-text-muted)]">осталось {item.stock}</span>
                      )}
                      {item.minLevel > 0 && (
                        <span className={`text-[11px] ${locked ? 'font-semibold' : 'text-[var(--color-text-muted)]'}`} style={locked ? { color: 'var(--color-warning, #e8590c)' } : undefined}>
                          от {item.minLevel} ур.
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">срок годности {item.ttlMonths} мес</div>
                    {isSelf && (
                      <div className="flex gap-2">
                        <button type="button" disabled={buy.isPending || !canBuy}
                          onClick={() => requestBuy(item)}
                          title={blockedReason ?? undefined}
                          className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-inverse)] disabled:opacity-40">
                          {soldOut ? 'Нет в наличии' : locked ? `С ${item.minLevel} ур.` : limitReached ? 'Лимит исчерпан' : 'Купить'}
                        </button>
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
        сроком годности. Активация — заявкой руководителю (кроме позиций без подтверждения — выдаются сразу); отказ
        возвращает предмет. По истечении срока возвращается 50% цены.
      </div>
      <ConfirmDialog
        open={!!pendingBuy}
        title="Подтвердите покупку"
        description={pendingBuy?.text ?? ''}
        confirmLabel="Купить"
        pending={buy.isPending}
        onConfirm={() => { if (pendingBuy) { const item = pendingBuy.item; setPendingBuy(null); buy.mutate(item); } }}
        onCancel={() => setPendingBuy(null)}
      />
      <PinSetupDialog
        open={!!pinSetupItem}
        onOpenChange={(o) => { if (!o) setPinSetupItem(null); }}
        onSuccess={() => { const item = pinSetupItem; setPinSetupItem(null); if (item) buy.mutate(item); }}
      />
      <PinDialog
        open={!!pinVerifyItem}
        onOpenChange={(o) => { if (!o) setPinVerifyItem(null); }}
        title="Подтвердите покупку пином"
        description={pinVerifyItem ? `«${pinVerifyItem.name}» — ${pinVerifyItem.priceEball.toLocaleString('ru-RU')} ${currencyName}` : undefined}
        onConfirm={async (pin) => {
          if (!pinVerifyItem) return { ok: false, error: 'Нет позиции' };
          const item = pinVerifyItem;
          const r = await fetchPinGated('/api/shop', 'POST', { itemId: item.id, pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyItem(null);
          setError(null);
          refresh();
          return { ok: true };
        }}
      />
    </div>
  );
}

// ── Таб «Инвентарь»: предметы + подарки коллегам ─────────────────────────────

function GiftModal({ row, meta, onClose, onDone }: {
  row: InventoryRow; meta: TransferMeta; onClose: () => void; onDone: () => void;
}) {
  const [to, setTo] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  // Подтверждение — вместо window.confirm (задача 2764).
  const [confirming, setConfirming] = useState(false);
  // Подарок — ценность уходит безвозвратно, пин ВСЕГДА (спека §3, задача
  // #2995/#3020); может прилететь и «заморожено после сброса пина» (423 БЕЗ
  // pinRequired) — тогда needsPinVerify=false и текст идёт прямо в error, без
  // диалога пина (ввод пина тут не поможет).
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [pinVerifyOpen, setPinVerifyOpen] = useState(false);
  const gift = useMutation({
    mutationFn: async (pin?: string) => {
      const r = await fetchPinGated('/api/shop/gift', 'POST', { inventoryId: row.id, toBitrixId: to, ...(pin ? { pin } : {}) });
      if (r.ok) return { done: true } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: true } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: true } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) { onDone(); return; }
      if (res.needsSetup) setPinSetupOpen(true);
      if (res.needsVerify) setPinVerifyOpen(true);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const toName = meta.managers.find(m => m.id === to)?.name ?? to;
  return (
    // Modal вместо самописного fixed inset-0 (задача 2764, правило 3 CLAUDE.md).
    // Прячем это окно (не размонтируем), пока открыт PinSetupDialog/PinDialog —
    // иначе два модала складываются в стопку (живая находка, задача #3020).
    // onOpenChange защищён тем же условием — иначе Radix закрывает родителя
    // вместе с собой и PinDialog размонтируется, не успев отрисоваться
    // (тоже поймано живьём).
    <Modal
      open={!pinSetupOpen && !pinVerifyOpen}
      onOpenChange={(o) => { if (!o && !pinSetupOpen && !pinVerifyOpen) onClose(); }}
      title={`Подарить: ${row.item_name}`} desktopWidth="sm:max-w-sm">
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
          <button type="button" disabled={gift.isPending || to === ''} onClick={() => { setError(null); setConfirming(true); }}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {gift.isPending ? 'Отправка…' : 'Подарить'}
          </button>
        </div>
      <ConfirmDialog
        open={confirming}
        title="Подтвердите подарок"
        description={`Подарить «${row.item_name}» → ${toName}?\n\nПредмет уйдёт из вашего инвентаря, срок годности (до ${fmtDate(row.expires_at)}) сохранится.`}
        confirmLabel="Подарить"
        pending={gift.isPending}
        onConfirm={() => { setConfirming(false); gift.mutate(undefined); }}
        onCancel={() => setConfirming(false)}
      />
      <PinSetupDialog
        open={pinSetupOpen}
        onOpenChange={setPinSetupOpen}
        onSuccess={() => { setPinSetupOpen(false); gift.mutate(undefined); }}
      />
      <PinDialog
        open={pinVerifyOpen}
        onOpenChange={setPinVerifyOpen}
        title="Подтвердите подарок пином"
        description={`«${row.item_name}» → ${toName}`}
        onConfirm={async (pin) => {
          const r = await fetchPinGated('/api/shop/gift', 'POST', { inventoryId: row.id, toBitrixId: to, pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyOpen(false);
          setError(null);
          onDone();
          return { ok: true };
        }}
      />
    </Modal>
  );
}

export function InventoryTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [gifting, setGifting] = useState<InventoryRow | null>(null);
  const { data } = useShopData(managerId, isSelf);
  const { data: meta } = useTransferMeta(isSelf);
  const currencyName = data?.currencyName ?? 'MLT';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shop'] });
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  // Заявка на активацию — вместо window.prompt (задача 2764): маленькая форма
  // (необязательный комментарий) вместо системного текстового окна.
  const [activatingRow, setActivatingRow] = useState<InventoryRow | null>(null);
  const [activateComment, setActivateComment] = useState('');
  const activate = useMutation({
    mutationFn: async ({ row, comment }: { row: InventoryRow; comment: string }) => {
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
        {/* Всегда виден, включая 0 (правка владельца 02.08) — см. ProfileTab. */}
        <RubPill balance={data?.rubBalance ?? 0} />
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
                      <button type="button" onClick={() => { setActivatingRow(row); setActivateComment(''); }} disabled={activate.isPending}
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
      <Modal
        open={!!activatingRow}
        onOpenChange={(o) => { if (!o) setActivatingRow(null); }}
        title={`Заявка руководителю: ${activatingRow?.item_name ?? ''}`}
        desktopWidth="sm:max-w-sm"
      >
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Пожелание (дата и т.п.) — необязательно
          <textarea autoFocus value={activateComment} onChange={e => setActivateComment(e.target.value)} rows={3}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-base sm:text-sm" />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setActivatingRow(null)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={activate.isPending}
            onClick={() => { if (activatingRow) { const row = activatingRow; const comment = activateComment; setActivatingRow(null); activate.mutate({ row, comment }); } }}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {activate.isPending ? 'Отправка…' : 'Отправить заявку'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

// ── Перевод MLT коллеге (блок в табе «Награды») ──────────────────────────────

export function TransferBlock({ balance, currencyName }: { balance: number; currencyName: string }) {
  const qc = useQueryClient();
  const { data: meta } = useTransferMeta(true);
  const [to, setTo] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // Подтверждение перевода — вместо window.confirm (задача 2764).
  const [pendingTransfer, setPendingTransfer] = useState<string | null>(null);
  // Перевод — ценность уходит безвозвратно, пин ВСЕГДА (спека §3, задача
  // #2995/#3020); возможна и заморозка после сброса пина (423 без pinRequired) —
  // тогда needsPinVerify=false, текст идёт прямо в error, диалог не открывается.
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [pinVerifyOpen, setPinVerifyOpen] = useState(false);

  const send = useMutation({
    mutationFn: async (pin?: string) => {
      const v = Number(amount);
      const r = await fetchPinGated<{ received: number; fee: number }>('/api/shop/transfer', 'POST', {
        toBitrixId: to, amount: v, comment: comment.trim(), ...(pin ? { pin } : {}),
      });
      if (r.ok) return { done: true, ...r.data! } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: true } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: true } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) {
        setError(null); setAmount(''); setComment(''); setTo('');
        setOkMsg(`Готово: получателю дошло ${res.received}, комиссия ${res.fee} сожжена`);
        void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
        void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
        void qc.invalidateQueries({ queryKey: ['shop-transfer-meta'] });
        return;
      }
      if (res.needsSetup) setPinSetupOpen(true);
      if (res.needsVerify) setPinVerifyOpen(true);
    },
    onError: (e) => { setOkMsg(null); setError(e instanceof Error ? e.message : String(e)); },
  });

  function requestTransferConfirm() {
    setError(null);
    const v = Number(amount);
    if (to === '') return setError('Выберите получателя');
    if (!Number.isInteger(v) || v <= 0) return setError('Сумма — целое число больше нуля');
    const fee = Math.floor(v * (meta?.feePercent ?? 5) / 100);
    const toName = meta?.managers.find(m => m.id === to)?.name ?? to;
    setPendingTransfer(
      `Перевести ${v} ${currencyName} → ${toName}?\n\nПолучит: ${v - fee} (комиссия ${meta?.feePercent ?? 5}% = ${fee} сжигается).` +
      (comment.trim() ? `\nКомментарий: ${comment.trim()}` : ''),
    );
  }

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
          onClick={requestTransferConfirm}
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
      <ConfirmDialog
        open={!!pendingTransfer}
        title="Подтвердите перевод"
        description={pendingTransfer ?? ''}
        confirmLabel="Перевести"
        pending={send.isPending}
        onConfirm={() => { setPendingTransfer(null); send.mutate(undefined); }}
        onCancel={() => setPendingTransfer(null)}
      />
      <PinSetupDialog
        open={pinSetupOpen}
        onOpenChange={setPinSetupOpen}
        onSuccess={() => { setPinSetupOpen(false); send.mutate(undefined); }}
      />
      <PinDialog
        open={pinVerifyOpen}
        onOpenChange={setPinVerifyOpen}
        title="Подтвердите перевод пином"
        description={`${amount} ${currencyName} → ${meta?.managers.find(m => m.id === to)?.name ?? to}`}
        onConfirm={async (pin) => {
          const v = Number(amount);
          const r = await fetchPinGated<{ received: number; fee: number }>('/api/shop/transfer', 'POST', {
            toBitrixId: to, amount: v, comment: comment.trim(), pin,
          });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyOpen(false);
          setError(null); setAmount(''); setComment(''); setTo('');
          setOkMsg(`Готово: получателю дошло ${r.data!.received}, комиссия ${r.data!.fee} сожжена`);
          void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
          void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
          void qc.invalidateQueries({ queryKey: ['shop-transfer-meta'] });
          return { ok: true };
        }}
      />
    </section>
  );
}

// ── Колокольчик уведомлений (шапка ЛК) ───────────────────────────────────────

// NotificationsBell удалён 05.08 (правка владельца «колокольчик убрать»):
// уведомления — раздел /profile/notifications, features/profile/ui/NotificationsPage.tsx.
