'use client';

// «Настройки → Награды» (задача 2655, этап 1): каталог бейджей — вкл/выкл,
// редактирование числовых порогов criteria, счётчики выдач. Конструктора
// НОВЫХ наград нет (этап 2, решение владельца).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import {
  CUSTOM_PREFIX, CUSTOM_PERIOD_LABELS, METRIC_LABELS, MILESTONE_KIND_LABELS,
  TEMPLATE_LABELS, validateCustomCriteria,
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
      <div
        className="mt-8 w-full max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-5 shadow-xl"
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
              <Field label={`Цена в «${currencyName}»`}>
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

export function RewardsSettingsPage() {
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
      return res.json() as Promise<{ stats: { inserted: number; updated: number; total: number; coinsAccrued: number; coinsEmitted: number; ms: number } }>;
    },
    onSuccess: (d) => {
      setRecomputeResult(`+${d.stats.inserted} новых, ${d.stats.updated} обновлено, валюта: +${d.stats.coinsAccrued} начислений на ${d.stats.coinsEmitted.toLocaleString('ru-RU')}, ${Math.round(d.stats.ms / 1000)} с`);
      void qc.invalidateQueries({ queryKey: ['settings-badges'] });
    },
    onError: (e) => setRecomputeResult(`Ошибка: ${e instanceof Error ? e.message : e}`),
  });

  const currencyName = data?.currencyName ?? 'ебаллы';
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
  const confirmDelete = (r: Row) => {
    const ok = window.confirm(
      `Удалить награду «${r.name}»?\n\nОна исчезнет из каталога и с полок менеджеров (наград: ${r.awards}). ` +
      `Уже начисленные «${currencyName}» за неё НЕ отзываются и останутся на балансах — принцип леджера.`,
    );
    if (ok) remove.mutate(r.key);
  };

  const rows = data?.rows ?? [];
  const byCategory = new Map<string, Row[]>();
  for (const r of rows) {
    (byCategory.get(r.category) ?? byCategory.set(r.category, []).get(r.category)!).push(r);
  }

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Награды</h1>
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
    </div>
  );
}
