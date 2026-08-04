'use client';

// «Настройки → Награды» (задача 2655, этап 1): каталог бейджей — вкл/выкл,
// редактирование числовых порогов criteria, счётчики выдач. Конструктора
// НОВЫХ наград нет (этап 2, решение владельца).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUrlState, enumParam } from '@/lib/hooks/useUrlState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { PayoutManageBlock } from './PayoutManage';
import { InventoryManageBlock } from './InventoryManage';
import { ShopSettingsBlock } from './ShopSettings';
import { GachaSettingsBlock } from './GachaSettings';
import { XpSettingsBlock } from './XpSettings';
import { QuestSettingsBlock } from './QuestSettings';
import { GamificationDashboard } from './GamificationDashboard';
import { DigestSettingsBlock } from './DigestSettings';
import { OutboundLogBlock } from './OutboundLog';
import { FeedbackQueueBlock } from './FeedbackQueue';
import { MltCoin } from '@/components/icons/MltCoin';
import {
  CUSTOM_PREFIX, CUSTOM_PERIOD_LABELS, DAILY_BONUS_METRIC_LABELS, METRIC_LABELS,
  MILESTONE_KIND_LABELS, TEMPLATE_LABELS, validateCustomCriteria,
  type CustomTemplate,
} from '@/features/badges/engine/customTemplates';

interface Row {
  key: string; name: string; description: string; icon: string; category: string;
  tiered: boolean; criteria: Record<string, unknown>; enabled: boolean;
  awards: number; holders: number;
  // Цены валюты (задача 2657): {'-': цена} или {bronze..platinum: цена}.
  prices: Record<string, number>;
}

const TIER_PRICE_LABELS: Record<string, string> = {
  '-': 'цена', bronze: 'бронза', silver: 'серебро', gold: 'золото', platinum: 'платина',
};
const TIER_PRICE_ORDER = ['-', 'bronze', 'silver', 'gold', 'platinum'];

const CATEGORY_LABELS: Record<string, string> = {
  top: 'Периодические топы', crosssell: 'Кросс-селл', rare: 'Редкие',
  repeat: 'Повторные продажи', speed: 'Скорость', record: 'Рекорды',
  streak: 'Серии', hygiene: 'Гигиена воронки', milestone: 'Вехи',
  custom: 'Свои награды (конструктор)',
};

const CRITERIA_LABELS: Record<string, string> = {
  minAmount: 'мин. сумма, ₽', minPairs: 'мин. связок', minGroups: 'мин. групп',
  minRepeats: 'мин. повторок', minDeals: 'мин. сделок/мес', days: 'дней подряд', count: 'порог, шт',
  threshold: 'порог',
};

function ThresholdInput({ row, k, onSave }: { row: Row; k: string; onSave: (patch: Record<string, unknown>) => void }) {
  const initial = row.criteria[k];
  const [draft, setDraft] = useState(String(initial ?? ''));
  const commit = () => {
    const v = Number(draft);
    if (!Number.isFinite(v) || v < 0 || String(initial) === draft) { setDraft(String(initial ?? '')); return; }
    onSave({ criteria: { ...row.criteria, [k]: v } });
  };
  return (
    <label className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
      {CRITERIA_LABELS[k] ?? k}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
      />
    </label>
  );
}

// Цена награды (2657): инпут на уровень; сохранение по blur/Enter. Меняет только
// БУДУЩИЕ начисления — прошлые транзакции леджера остаются по старой цене.
function PriceInput({ row, tier, currencyName, onSave }: {
  row: Row; tier: string; currencyName: string;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const initial = row.prices[tier];
  const [draft, setDraft] = useState(String(initial ?? ''));
  const commit = () => {
    const v = Number(draft);
    if (!Number.isInteger(v) || v < 0 || String(initial) === draft) { setDraft(String(initial ?? '')); return; }
    onSave({ prices: { [tier]: v } });
  };
  return (
    <label className="inline-flex items-center gap-1 text-xs text-[var(--color-accent)]" title={`Цена в «${currencyName}» — влияет только на будущие начисления`}>
      <MltCoin size={12} title={currencyName} />
      {TIER_PRICE_LABELS[tier] ?? tier}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        className="w-16 rounded border border-[var(--color-accent)]/40 bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
      />
    </label>
  );
}

// ── Конструктор наград (этап 2): форма создания из параметризуемых шаблонов ──

const EMOJI_PRESETS = ['🏅', '🏆', '🥇', '🎖️', '⭐', '🌟', '💎', '🔥', '🚀', '🎯', '🧩', '💰', '📈', '👑', '🛡️', '⚡', '🃏', '🦾', '🎁', '🧲'];
const TIER_KEYS = ['bronze', 'silver', 'gold', 'platinum'] as const;

const selectCls = 'rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs';
const inputCls = 'rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      {label}
      {children}
    </label>
  );
}

function CreateBadgeModal({ currencyName, onClose, onCreated }: {
  currencyName: string; onClose: () => void; onCreated: () => void;
}) {
  const [template, setTemplate] = useState<CustomTemplate>('top_metric');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('🏅');
  const [enabled, setEnabled] = useState(true);
  // параметры шаблонов
  const [metric, setMetric] = useState('sales_amount');
  const [period, setPeriod] = useState('day');
  const [tieredScopes, setTieredScopes] = useState(true);
  const [threshold, setThreshold] = useState('');
  const [firstGroup, setFirstGroup] = useState('');
  const [nextGroup, setNextGroup] = useState('');
  const [minPairs, setMinPairs] = useState('1');
  const [days, setDays] = useState('5');
  const [kind, setKind] = useState('sales_count');
  const [dailyMetric, setDailyMetric] = useState('bookings_plus_sales_count');
  const [silent, setSilent] = useState(false);
  const [indexUnits, setIndexUnits] = useState('');
  // Двухвалютная система (миграция 116): ежедневный бонус может платить РУБЛИ
  // («брони+продажи = +500 ₽», привычная менеджерам механика) или ебаллы.
  const [bonusCurrency, setBonusCurrency] = useState<'EBALL' | 'RUB'>('RUB');
  // цены
  const [priceFlat, setPriceFlat] = useState('50');
  const [tierPrices, setTierPrices] = useState<Record<string, string>>({ bronze: '5', silver: '15', gold: '50', platinum: '150' });
  const [error, setError] = useState<string | null>(null);

  const tiered = template === 'top_metric' && tieredScopes;

  // Head-группы для кросс-селла — реальные, из данных (грузим лениво по шаблону).
  const { data: groupsData } = useQuery<{ groups: string[] }>({
    queryKey: ['badge-head-groups'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/groups');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: template === 'crosssell_pair',
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const groups = groupsData?.groups ?? [];

  const create = useMutation({
    mutationFn: async () => {
      const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
      const criteria: Record<string, unknown> = { template };
      if (template === 'top_metric') Object.assign(criteria, { metric, period, tieredScopes });
      if (template === 'threshold_period') Object.assign(criteria, { metric, period, threshold: num(threshold) });
      if (template === 'crosssell_pair') Object.assign(criteria, { firstGroup, nextGroup, minPairs: num(minPairs) });
      if (template === 'streak') Object.assign(criteria, { days: num(days) });
      if (template === 'milestone') Object.assign(criteria, { kind, threshold: num(threshold) });
      if (template === 'daily_bonus') {
        Object.assign(criteria, { dailyMetric, threshold: num(threshold), silent, currency: bonusCurrency });
        const iu = num(indexUnits);
        if (iu !== undefined) Object.assign(criteria, { indexUnits: iu }); // задел индексации (пока не активно)
      }

      // клиентская валидация — тем же модулем, что и сервер
      if (!name.trim()) throw new Error('Название не может быть пустым');
      const v = validateCustomCriteria(criteria);
      if (!v.ok) throw new Error(v.error);

      const prices: Record<string, number> = {};
      if (tiered) {
        for (const t of TIER_KEYS) {
          const p = Number(tierPrices[t]);
          if (!Number.isInteger(p) || p < 0) throw new Error(`Цена (${TIER_PRICE_LABELS[t]}): целое число от 0`);
          prices[t] = p;
        }
      } else {
        const p = Number(priceFlat);
        if (!Number.isInteger(p) || p < 0) throw new Error('Цена: целое число от 0');
        prices['-'] = p;
      }

      const res = await fetch('/api/settings/badges', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), icon, enabled, criteria, prices }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: onCreated,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      {/* Регресс #2999 (04.08): самописный диалог (не на <Modal>) с прозрачным
          --color-bg-surface без backdrop-filter — контент страницы позади был виден.
          Владелец: если блюр не нужен точечно — просто непрозрачный фон, без стекла;
          здесь это самый дешёвый безопасный фикс для самописного (не Modal.tsx) диалога. */}
      <div
        className="mt-8 w-full max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold">Создать награду</h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-[var(--color-bg-hover)]"><X size={16} /></button>
        </div>

        <div className="flex flex-col gap-3">
          <Field label="Тип шаблона">
            <select value={template} onChange={e => { setTemplate(e.target.value as CustomTemplate); setError(null); }} className={selectCls}>
              {(Object.keys(TEMPLATE_LABELS) as CustomTemplate[]).map(t => (
                <option key={t} value={t}>{TEMPLATE_LABELS[t].name}</option>
              ))}
            </select>
          </Field>
          <div className="text-xs text-[var(--color-text-muted)]">{TEMPLATE_LABELS[template].hint}</div>

          {/* динамические параметры по типу шаблона */}
          {(template === 'top_metric' || template === 'threshold_period') && (
            <div className="flex flex-wrap gap-3">
              <Field label="Метрика">
                <select value={metric} onChange={e => setMetric(e.target.value)} className={selectCls}>
                  {Object.entries(METRIC_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
              <Field label="Период">
                <select value={period} onChange={e => setPeriod(e.target.value)} className={selectCls}>
                  {Object.entries(CUSTOM_PERIOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
              {template === 'top_metric' && (
                <label className="flex items-end gap-1.5 pb-1 text-xs">
                  <input type="checkbox" checked={tieredScopes} onChange={e => setTieredScopes(e.target.checked)} />
                  уровневая (отдел/департамент/филиал/страна)
                </label>
              )}
              {template === 'threshold_period' && (
                <Field label={metric.endsWith('_count') ? 'Порог, шт' : 'Порог, ₽'}>
                  <input value={threshold} onChange={e => setThreshold(e.target.value)} className={`${inputCls} w-32 text-right tabular-nums`} placeholder="500000" />
                </Field>
              )}
            </div>
          )}

          {template === 'crosssell_pair' && (
            <div className="flex flex-wrap gap-3">
              <Field label="Сначала купил (X)">
                <select value={firstGroup} onChange={e => setFirstGroup(e.target.value)} className={`${selectCls} max-w-56`}>
                  <option value="">— группа —</option>
                  {groups.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </Field>
              <Field label="Затем допродали (Y)">
                <select value={nextGroup} onChange={e => setNextGroup(e.target.value)} className={`${selectCls} max-w-56`}>
                  <option value="">— группа —</option>
                  {groups.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </Field>
              <Field label="Мин. пар">
                <input value={minPairs} onChange={e => setMinPairs(e.target.value)} className={`${inputCls} w-20 text-right tabular-nums`} />
              </Field>
            </div>
          )}

          {template === 'streak' && (
            <Field label="Рабочих дней подряд с продажей">
              <input value={days} onChange={e => setDays(e.target.value)} className={`${inputCls} w-24 text-right tabular-nums`} />
            </Field>
          )}

          {template === 'milestone' && (
            <div className="flex flex-wrap gap-3">
              <Field label="Вид вехи">
                <select value={kind} onChange={e => setKind(e.target.value)} className={selectCls}>
                  {Object.entries(MILESTONE_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
              <Field label={kind === 'sales_count' ? 'Порог, шт' : 'Порог, ₽'}>
                <input value={threshold} onChange={e => setThreshold(e.target.value)} className={`${inputCls} w-32 text-right tabular-nums`} placeholder="100" />
              </Field>
            </div>
          )}

          {template === 'daily_bonus' && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                <Field label="Метрика дня">
                  <select value={dailyMetric} onChange={e => setDailyMetric(e.target.value)} className={selectCls}>
                    {Object.entries(DAILY_BONUS_METRIC_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Field>
                <Field label={dailyMetric.endsWith('amount') ? 'Порог, ₽' : 'Порог, шт'}>
                  <input value={threshold} onChange={e => setThreshold(e.target.value)} className={`${inputCls} w-28 text-right tabular-nums`} placeholder="5" />
                </Field>
                {/* Задел под индексацию магазина: пока не активно, включится с
                    магазинной индексацией (owners-inbox/monolitika-eball-indexation.md) */}
                <Field label="Сумма в единицах индекса (скоро)">
                  <input value={indexUnits} onChange={e => setIndexUnits(e.target.value)} disabled
                    title="Включится с магазинной индексацией" className={`${inputCls} w-28 text-right tabular-nums opacity-50`} />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Field label="Валюта начисления">
                  <select value={bonusCurrency} onChange={e => setBonusCurrency(e.target.value as 'EBALL' | 'RUB')} className={selectCls}>
                    <option value="RUB">Рубли (₽) — денежный бонус</option>
                    <option value="EBALL">{currencyName}</option>
                  </select>
                </Field>
                <label className="flex items-end gap-1.5 pb-1 text-xs">
                  <input type="checkbox" checked={silent} onChange={e => setSilent(e.target.checked)} />
                  тихое начисление — только выписка и баланс, без бейджа на полке
                </label>
              </div>
            </div>
          )}

          <div className="border-t border-[var(--color-border)] pt-3" />

          <div className="flex flex-wrap gap-3">
            <Field label="Название">
              <input value={name} onChange={e => setName(e.target.value)} maxLength={200} className={`${inputCls} w-64`} placeholder="Например: Полмиллиона за день" />
            </Field>
            <Field label="Иконка (эмодзи)">
              <input value={icon} onChange={e => setIcon(e.target.value)} maxLength={16} className={`${inputCls} w-16 text-center text-base`} />
            </Field>
            <label className="flex items-end gap-1.5 pb-1 text-xs">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              включена
            </label>
          </div>
          <div className="flex flex-wrap gap-1">
            {EMOJI_PRESETS.map(e => (
              <button key={e} type="button" onClick={() => setIcon(e)}
                className={`rounded-lg border px-1.5 py-0.5 text-base ${icon === e ? 'border-[var(--color-accent)]' : 'border-transparent hover:border-[var(--color-border)]'}`}>
                {e}
              </button>
            ))}
          </div>
          <Field label="Описание (пусто — сгенерируется из параметров)">
            <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} rows={2} className={inputCls} />
          </Field>

          <div className="flex flex-wrap items-end gap-3">
            {tiered ? TIER_KEYS.map(t => (
              <Field key={t} label={`Цена, ${TIER_PRICE_LABELS[t]}`}>
                <input value={tierPrices[t]} onChange={e => setTierPrices(p => ({ ...p, [t]: e.target.value }))}
                  className={`${inputCls} w-20 text-right tabular-nums`} />
              </Field>
            )) : (
              <Field label={template === 'daily_bonus'
                ? `Начисление за день выполнения, ${bonusCurrency === 'RUB' ? '₽' : `«${currencyName}»`}`
                : `Цена в «${currencyName}»`}>
                <input value={priceFlat} onChange={e => setPriceFlat(e.target.value)} className={`${inputCls} w-24 text-right tabular-nums`} />
              </Field>
            )}
          </div>

          <div className="rounded-lg bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            Награда посчитается и за прошлое (с 03.04.2026): начисления появятся этой ночью или сразу — по кнопке «Пересчитать награды».
          </div>

          {error && <div className="text-xs text-red-500">{error}</div>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
            <button
              type="button"
              onClick={() => { setError(null); create.mutate(); }}
              disabled={create.isPending}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {create.isPending ? 'Создание…' : 'Создать'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Штрафы и бюджет поощрений (доп. Серёги 31.07): админский справочник ──────

interface PenaltyRow { id: number; name: string; price: number; price_mode: 'fixed' | 'percent'; enabled: boolean; uses: number }

function PenaltiesSettings({ currencyName }: { currencyName: string }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ types: PenaltyRow[]; monthlyBonusBudget: number; rubToEballRate: number }>({
    queryKey: ['settings-penalties'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/penalties');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['settings-penalties'] });
    void qc.invalidateQueries({ queryKey: ['penalty-types-public'] });
  };
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/settings/badges/penalties/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: invalidate,
  });

  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('50');
  const [newMode, setNewMode] = useState<'fixed' | 'percent'>('fixed');
  const [createError, setCreateError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/badges/penalties', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), price: Number(newPrice), priceMode: newMode }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => { setNewName(''); setCreateError(null); invalidate(); },
    onError: (e) => setCreateError(e instanceof Error ? e.message : String(e)),
  });

  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const saveBudget = useMutation({
    mutationFn: async (v: number) => {
      const res = await fetch('/api/settings/badges/budget', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyBonusBudget: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => { setBudgetDraft(null); invalidate(); },
  });
  const commitBudget = () => {
    const v = Number(budgetDraft);
    if (budgetDraft === null || !Number.isInteger(v) || v < 0) { setBudgetDraft(null); return; }
    saveBudget.mutate(v);
  };

  // Курс конвертации RUB → EBALL (двухвалютная система, миграция 116).
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const saveRate = useMutation({
    mutationFn: async (v: number) => {
      const res = await fetch('/api/settings/badges/rate', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rubToEballRate: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => { setRateDraft(null); invalidate(); },
  });
  const commitRate = () => {
    const v = Number(rateDraft);
    if (rateDraft === null || !Number.isFinite(v) || v <= 0) { setRateDraft(null); return; }
    saveRate.mutate(v);
  };

  return (
    <div className="mb-5 mt-8 border-t border-[var(--color-border)] pt-5">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Штрафы и поощрения (ручные операции)</h2>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title="Месячный лимит ручных поощрений на одного руководителя; 0 = без лимита. Штрафы без лимита.">
          Бюджет поощрений/мес на руководителя
          <input
            value={budgetDraft ?? String(data?.monthlyBonusBudget ?? '')}
            onChange={e => setBudgetDraft(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={e => { if (e.key === 'Enter') commitBudget(); }}
            className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title={`Сколько ${currencyName} даёт 1 ₽ при конвертации (только рубли → ${currencyName}; обратной нет)`}>
          Курс: 1 ₽ =
          <input
            value={rateDraft ?? String(data?.rubToEballRate ?? '')}
            onChange={e => setRateDraft(e.target.value)}
            onBlur={commitRate}
            onKeyDown={e => { if (e.key === 'Enter') commitRate(); }}
            className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
          />
          {currencyName}
        </label>
      </div>
      <div className="mb-2 text-xs text-[var(--color-text-muted)]">
        Справочник причин штрафов: «фикс» — сумма в «{currencyName}», «%» — процент от накопленного баланса на момент штрафа
        (сумма фиксируется в выписке и не пересчитывается). Менеджеры видят справочник в ЛК (read-only).
      </div>
      <div className="flex flex-col gap-1.5">
        {(data?.types ?? []).map(t => (
          <PenaltyTypeRowView key={t.id} row={t} currencyName={currencyName}
            onPatch={(body) => patch.mutate({ id: t.id, body })} />
        ))}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] px-3 py-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Новая причина штрафа"
            className="min-w-48 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs" />
          <select value={newMode} onChange={e => setNewMode(e.target.value as 'fixed' | 'percent')}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-xs">
            <option value="fixed">фикс</option>
            <option value="percent">% от баланса</option>
          </select>
          <input value={newPrice} onChange={e => setNewPrice(e.target.value)}
            className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-right text-xs tabular-nums" />
          <button type="button" onClick={() => create.mutate()} disabled={create.isPending || !newName.trim()}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
            Добавить
          </button>
          {createError && <span className="text-xs text-red-500">{createError}</span>}
        </div>
      </div>
    </div>
  );
}

function PenaltyTypeRowView({ row, currencyName, onPatch }: {
  row: PenaltyRow; currencyName: string; onPatch: (body: Record<string, unknown>) => void;
}) {
  const [priceDraft, setPriceDraft] = useState(String(row.price));
  const commitPrice = () => {
    const v = Number(priceDraft);
    if (!Number.isInteger(v) || v <= 0 || v === row.price) { setPriceDraft(String(row.price)); return; }
    onPatch({ price: v });
  };
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2 ${row.enabled ? '' : 'opacity-60'}`}>
      <span className="min-w-0 flex-1 text-sm text-[var(--color-text)]">{row.name}</span>
      <select value={row.price_mode} onChange={e => onPatch({ priceMode: e.target.value })}
        className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-xs">
        <option value="fixed">фикс, {currencyName}</option>
        <option value="percent">% от баланса</option>
      </select>
      <input value={priceDraft} onChange={e => setPriceDraft(e.target.value)} onBlur={commitPrice}
        onKeyDown={e => { if (e.key === 'Enter') commitPrice(); }}
        className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums" />
      <span className="text-xs tabular-nums text-[var(--color-text-muted)]" title="применений">{row.uses}×</span>
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
        <input type="checkbox" checked={row.enabled} onChange={e => onPatch({ enabled: e.target.checked })} />
        вкл
      </label>
    </div>
  );
}

// Табы раздела «Геймификация» (задача 2741, бриф Серёги 01.08): всё, что
// раньше было одной длинной страницей «Настройки → Награды», перекомпоновано
// в табы — первый таб «Дашборд» с живой сводкой экономики. Роут и все
// query-ключи ниже НЕ меняются (страница по-прежнему живёт на /settings/rewards) —
// прямых ссылок на прежние секции не было (это всегда была одна страница),
// поэтому 404 старым URL не грозит.
const TABS = [
  { key: 'dashboard', label: 'Дашборд' },
  { key: 'catalog', label: 'Награды' },
  { key: 'penalties', label: 'Штрафы' },
  { key: 'xp', label: 'XP' },
  { key: 'quests', label: 'Квесты' },
  { key: 'shop', label: 'Магазин' },
  { key: 'gacha', label: 'Гача' },
  { key: 'payouts', label: 'Выплаты' },
  { key: 'inventory', label: 'Инвентарь' },
  // Задача 2765 (02.08): дайджест менеджерам + система отладки сообщений бота.
  { key: 'digest', label: 'Дайджест' },
  { key: 'outbound', label: 'Исходящие' },
  { key: 'feedback', label: 'Обратная связь' },
] as const;
type TabKey = typeof TABS[number]['key'];

// Табы этой страницы уже переносятся на новую строку (flex-wrap) — та же
// болячка, что у ManagerTabBar/ReportTabsBar (полоса шире экрана, обрезана,
// активная вкладка не видна), тут структурно невозможна: нечему прятаться за
// краем, всё видно всегда. Задача 2779 проверяла именно этот класс бага — его
// здесь нет. Тач-таргет всё равно поднят до 44px на мобильном (было ~36px) —
// отдельное требование брифа, sm: возвращает прежнюю компактную высоту на десктопе.
function TabBar({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-[var(--color-border)]">
      {TABS.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`min-h-11 sm:min-h-0 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            active === t.key
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const TAB_KEYS = TABS.map(t => t.key);

export function RewardsSettingsPage() {
  // Задача 2824 (план из аудита адресуемости, п.1.4): 12 вкладок раздела —
  // единственное состояние всей страницы (см. шапку блока TABS выше) — теперь
  // адресуемы через ?tab=, по образцу ManagerCardPage.tsx::goToTab (тот же
  // паттерн: push, не replace — переключение таба это смысловой шаг истории,
  // «назад» должен возвращать на предыдущую вкладку, а не выкидывать со страницы).
  const [tab, setTab] = useUrlState<TabKey>('tab', { ...enumParam(TAB_KEYS, 'dashboard'), mode: 'push' });
  const qc = useQueryClient();
  const [recomputeResult, setRecomputeResult] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery<{ rows: Row[]; currencyName: string }>({
    queryKey: ['settings-badges'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const patch = useMutation({
    mutationFn: async ({ key, body }: { key: string; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/settings/badges/${encodeURIComponent(key)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings-badges'] }),
  });

  const recompute = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/badges/recompute', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ stats: { inserted: number; updated: number; total: number; coinsAccrued: number; coinsEmitted: number; ms: number; skipped?: boolean } }>;
    },
    onSuccess: (d) => {
      // Задача 2776: другой прогон (ночной тик или чьё-то ещё нажатие) уже держит
      // advisory-лок — этот вызов ничего не считал, показываем это явно, а не «+0 новых».
      if (d.stats.skipped) {
        setRecomputeResult('Пересчёт уже выполняется в другом прогоне — подождите и повторите');
      } else {
        setRecomputeResult(`+${d.stats.inserted} новых, ${d.stats.updated} обновлено, валюта: +${d.stats.coinsAccrued} начислений на ${d.stats.coinsEmitted.toLocaleString('ru-RU')}, ${Math.round(d.stats.ms / 1000)} с`);
      }
      void qc.invalidateQueries({ queryKey: ['settings-badges'] });
    },
    onError: (e) => setRecomputeResult(`Ошибка: ${e instanceof Error ? e.message : e}`),
  });

  const currencyName = data?.currencyName ?? 'MLT';
  const [currencyDraft, setCurrencyDraft] = useState<string | null>(null);
  const saveCurrency = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch('/api/settings/badges/currency', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currencyName: name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      setCurrencyDraft(null);
      // название используется во всех бейдж-эндпоинтах — сбрасываем их кэши
      void qc.invalidateQueries({ queryKey: ['settings-badges'] });
      void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
      void qc.invalidateQueries({ queryKey: ['badges-team'] });
      void qc.invalidateQueries({ queryKey: ['rating-badges'] });
    },
  });
  const commitCurrency = () => {
    const v = (currencyDraft ?? '').trim();
    if (!v || v === currencyName) { setCurrencyDraft(null); return; }
    saveCurrency.mutate(v);
  };

  // Удаление кастомной награды (этап 2): начисленные «ебаллы» НЕ отзываются
  // (принцип леджера) — предупреждаем в confirm.
  const remove = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`/api/settings/badges/${encodeURIComponent(key)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings-badges'] });
      void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
      void qc.invalidateQueries({ queryKey: ['badges-team'] });
      void qc.invalidateQueries({ queryKey: ['rating-badges'] });
    },
  });
  // Подтверждение удаления — вместо window.confirm (задача 2947, дочистка
  // системных окошек: тот же паттерн ConfirmDialog, что уже применён в ЛК
  // менеджера, задача 2764).
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const confirmDelete = (r: Row) => setDeleteTarget(r);

  const rows = data?.rows ?? [];
  const byCategory = new Map<string, Row[]>();
  for (const r of rows) {
    (byCategory.get(r.category) ?? byCategory.set(r.category, []).get(r.category)!).push(r);
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Геймификация</h1>
      </div>

      <TabBar active={tab} onChange={setTab} />

      {tab === 'dashboard' && <GamificationDashboard />}

      {tab === 'catalog' && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {/* Название валюты (2657): глобальная настройка, дефолт «ебаллы». */}
            <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              Название валюты
              <input
                value={currencyDraft ?? currencyName}
                onChange={e => setCurrencyDraft(e.target.value)}
                onBlur={commitCurrency}
                onKeyDown={e => { if (e.key === 'Enter') commitCurrency(); }}
                maxLength={40}
                className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs"
              />
            </label>
            <button
              type="button"
              onClick={() => recompute.mutate()}
              disabled={recompute.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
            >
              <RefreshCw size={12} className={recompute.isPending ? 'animate-spin' : ''} />
              {recompute.isPending ? 'Пересчёт…' : 'Пересчитать награды'}
            </button>
            {/* Конструктор наград (этап 2): свои награды из параметризуемых шаблонов */}
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white"
            >
              <Plus size={12} />
              Создать награду
            </button>
            {recomputeResult && <span className="text-xs text-[var(--color-text-muted)]">{recomputeResult}</span>}
          </div>

          {showCreate && (
            <CreateBadgeModal
              currencyName={currencyName}
              onClose={() => setShowCreate(false)}
              onCreated={() => {
                setShowCreate(false);
                void qc.invalidateQueries({ queryKey: ['settings-badges'] });
              }}
            />
          )}

          {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}

          {[...byCategory.entries()].map(([cat, list]) => (
            <div key={cat} className="mb-5">
              <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-muted)]">{CATEGORY_LABELS[cat] ?? cat}</h2>
              <div className="flex flex-col gap-1.5">
                {list.map(r => (
                  <div key={r.key} className={`flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2 ${r.enabled ? '' : 'opacity-60'}`}>
                    <span className="text-xl">{r.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{r.name}
                        {r.tiered && <span className="ml-1.5 text-[10px] font-normal uppercase text-[var(--color-text-muted)]">уровни</span>}
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)]">{r.description}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      {Object.keys(r.criteria).filter(k => typeof r.criteria[k] === 'number').map(k => (
                        <ThresholdInput key={k} row={r} k={k} onSave={(body) => patch.mutate({ key: r.key, body })} />
                      ))}
                      {/* Цены валюты (2657): по уровням для tiered, одна для остальных */}
                      {TIER_PRICE_ORDER.filter(t => (r.tiered ? t !== '-' : t === '-')).map(t => (
                        <PriceInput key={t} row={r} tier={t} currencyName={currencyName}
                          onSave={(body) => patch.mutate({ key: r.key, body })} />
                      ))}
                      <span className="text-xs tabular-nums text-[var(--color-text-muted)]" title="выдач / обладателей">
                        {r.awards} / {r.holders}
                      </span>
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          onChange={e => patch.mutate({ key: r.key, body: { enabled: e.target.checked } })}
                        />
                        вкл
                      </label>
                      {r.key.startsWith(CUSTOM_PREFIX) && (
                        <button
                          type="button"
                          onClick={() => confirmDelete(r)}
                          title="Удалить награду (начисленная валюта не отзывается)"
                          className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-red-500"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {/* Ручные операции (доп. Серёги 31.07): справочник штрафов + бюджет поощрений */}
      {tab === 'penalties' && !isLoading && <PenaltiesSettings currencyName={currencyName} />}
      {/* XP-система (01.08, миграция 124): коэффициенты + классы (домены) */}
      {tab === 'xp' && !isLoading && <XpSettingsBlock />}
      {/* Квесты (миграция 125): номиналы, тиры, реролл */}
      {tab === 'quests' && !isLoading && <QuestSettingsBlock />}
      {/* Магазин призов (MVP 31.07): каталог + TTL валюты + «Релизный старт» (заложен, не запускался) */}
      {tab === 'shop' && !isLoading && <ShopSettingsBlock currencyName={currencyName} />}
      {/* Гача (фаза 2): пул, шансы (валидация 100%), счётчик джекпотов */}
      {tab === 'gacha' && !isLoading && <GachaSettingsBlock currencyName={currencyName} />}
      {/* Заявки на вывод рублей в ЗП: у админа — все (у РОПа тот же блок в его ЛК) */}
      {tab === 'payouts' && !isLoading && <PayoutManageBlock />}
      {/* Заявки на активацию призов магазина: у админа — все */}
      {tab === 'inventory' && !isLoading && <InventoryManageBlock />}
      {/* Дайджест менеджерам + отладка сообщений (задача 2765, 02.08) */}
      {tab === 'digest' && <DigestSettingsBlock />}
      {tab === 'outbound' && <OutboundLogBlock />}
      {tab === 'feedback' && <FeedbackQueueBlock />}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Удалить награду?"
        description={deleteTarget
          ? `Удалить награду «${deleteTarget.name}»?\n\nОна исчезнет из каталога и с полок менеджеров (наград: ${deleteTarget.awards}). ` +
            `Уже начисленные «${currencyName}» за неё НЕ отзываются и останутся на балансах — принцип леджера.`
          : ''}
        confirmLabel="Удалить"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => { if (deleteTarget) { remove.mutate(deleteTarget.key); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
