'use client';
// Настройки магазина (MVP, 31.07): управление каталогом (создать/редактировать/
// выключить, цена, сток, срок годности) — админский паттерн, как штрафы;
// срок жизни ебаллов (TTL); «Релизный старт» — механизм заложен по решению
// Серёги, НЕ ЗАПУСКАЛСЯ (двойное подтверждение, одноразовый).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MltCoin } from '@/components/icons/MltCoin';

interface ShopItemRow {
  id: number; name: string; description: string | null; category: 'material' | 'immaterial' | 'team';
  priceUnits: number; priceEball: number; priceRub: number | null;
  allowedCurrencies: string[]; enabled: boolean; stock: number | null;
  ttlMonths: number; sort: number; purchases: number;
}

const CAT_LABELS: Record<string, string> = {
  immaterial: 'Нематериальные', material: 'Материальные', team: 'Командные',
};

function ItemEditor({ item, currencyName, onClose, onSaved }: {
  item: ShopItemRow | null; currencyName: string; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [category, setCategory] = useState<ShopItemRow['category']>(item?.category ?? 'immaterial');
  const [price, setPrice] = useState(String(item?.priceUnits ?? '100'));
  const [allowRub, setAllowRub] = useState(item?.allowedCurrencies.includes('RUB') ?? false);
  const [stock, setStock] = useState(item?.stock === null || item?.stock === undefined ? '' : String(item.stock));
  const [ttl, setTtl] = useState(String(item?.ttlMonths ?? 3));
  const [sort, setSort] = useState(String(item?.sort ?? 100));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(), description: description.trim() || null, category,
        priceUnits: Number(price), allowRub,
        stock: stock.trim() === '' ? null : Number(stock),
        ttlMonths: Number(ttl), sort: Number(sort),
      };
      if (item) body.id = item.id;
      const res = await fetch('/api/settings/badges/shop', {
        method: item ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-16 w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h2 className="mb-3 text-base font-bold text-[var(--color-text)]">
          {item ? `Позиция: ${item.name}` : 'Новая позиция каталога'}
        </h2>
        <div className="flex flex-col gap-2.5 text-xs text-[var(--color-text-muted)]">
          <label className="flex flex-col gap-1">Название
            <input value={name} onChange={e => setName(e.target.value)} maxLength={300}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]" />
          </label>
          <label className="flex flex-col gap-1">Описание
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} maxLength={1000}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]" />
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">Категория
              <select value={category} onChange={e => setCategory(e.target.value as ShopItemRow['category'])}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]">
                <option value="immaterial">Нематериальный</option>
                <option value="material">Материальный</option>
                <option value="team">Командный</option>
              </select>
            </label>
            <label className="flex flex-col gap-1" title={`Цена в единицах индексации; сейчас 1 единица = 1 ${currencyName}`}>
              Цена (ед. = {currencyName})
              <input value={price} onChange={e => setPrice(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-right text-sm tabular-nums text-[var(--color-text)]" />
            </label>
            <label className="flex flex-col gap-1" title="Пусто = безлимит">Сток (пусто = безлимит)
              <input value={stock} onChange={e => setStock(e.target.value)} placeholder="∞"
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-right text-sm tabular-nums text-[var(--color-text)]" />
            </label>
            <label className="flex flex-col gap-1">Срок годности, мес
              <input value={ttl} onChange={e => setTtl(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-right text-sm tabular-nums text-[var(--color-text)]" />
            </label>
            <label className="flex flex-col gap-1">Сортировка
              <input value={sort} onChange={e => setSort(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-right text-sm tabular-nums text-[var(--color-text)]" />
            </label>
            <label className="mt-5 inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={allowRub} onChange={e => setAllowRub(e.target.checked)} />
              можно за рубли
            </label>
          </div>
          {error && <div className="text-[var(--color-negative,#e03131)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-bg-hover)]">Отмена</button>
            <button type="button" disabled={save.isPending || !name.trim()} onClick={() => { setError(null); save.mutate(); }}
              className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 font-semibold text-white disabled:opacity-50">
              {save.isPending ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ShopSettingsBlock({ currencyName }: { currencyName: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<ShopItemRow | null | 'new'>(null);
  const { data } = useQuery<{ items: ShopItemRow[]; coinTtlMonths: number; transferFeePercent: number; transferDailyLimit: number }>({
    queryKey: ['settings-shop'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/shop');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['settings-shop'] });
    void qc.invalidateQueries({ queryKey: ['shop'] });
  };

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      const res = await fetch('/api/settings/badges/shop', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: invalidate,
  });

  // Срок жизни ебаллов (TTL): сгорание ночным тиком, RUB не сгорают.
  const [ttlDraft, setTtlDraft] = useState<string | null>(null);
  const saveTtl = useMutation({
    mutationFn: async (v: number) => {
      const res = await fetch('/api/settings/badges/ttl', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlMonths: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => { setTtlDraft(null); invalidate(); },
  });
  const commitTtl = () => {
    const v = Number(ttlDraft);
    if (ttlDraft === null || !Number.isInteger(v) || v <= 0) { setTtlDraft(null); return; }
    saveTtl.mutate(v);
  };

  // Настройки переводов (пакет 31.07): комиссия и дневной лимит.
  const saveTransfer = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/settings/badges/transfer', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['shop-transfer-meta'] });
    },
  });

  // «Релизный старт» — заложенный одноразовый механизм, НЕ запускался.
  const { data: release } = useQuery<{ startedAt: string | null }>({
    queryKey: ['settings-release'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/release');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const [releaseResult, setReleaseResult] = useState<string | null>(null);
  const releaseStart = useMutation({
    mutationFn: async () => {
      const raw = window.prompt(
        'РЕЛИЗНЫЙ СТАРТ (необратимо, одноразово):\n' +
        `— все текущие балансы «${currencyName}» будут ОБНУЛЕНЫ;\n` +
        '— каждому активному менеджеру начислится одинаковый старт;\n' +
        '— награды на полках и рубли НЕ трогаются.\n\n' +
        'Сумма стартового начисления:', '3000');
      if (raw === null) return false;
      const amount = Number(raw);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('Сумма — целое число больше нуля');
      const word = window.prompt(`Для подтверждения введите слово РЕЛИЗ (начислится по ${amount} каждому):`);
      if (word === null) return false;
      const res = await fetch('/api/settings/badges/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, confirm: word.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      const j = json as { zeroed: number; granted: number; amount: number };
      setReleaseResult(`Обнулено балансов: ${j.zeroed}, начислено ${j.amount} × ${j.granted} менеджерам`);
      return true;
    },
    onSuccess: (done) => {
      if (done) {
        void qc.invalidateQueries({ queryKey: ['settings-release'] });
        void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
      }
    },
    onError: (e) => setReleaseResult(e instanceof Error ? e.message : String(e)),
  });

  const items = data?.items ?? [];
  const byCat = new Map<string, ShopItemRow[]>();
  for (const i of items) (byCat.get(i.category) ?? byCat.set(i.category, []).get(i.category)!).push(i);

  return (
    <div className="mb-5 mt-8 border-t border-[var(--color-border)] pt-5">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Магазин призов</h2>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title={`Начисления «${currencyName}» живут этот срок, затем сгорают ночным пересчётом (FIFO: траты гасят старейшие). Рубли не сгорают.`}>
          Срок жизни {currencyName}, мес
          <input
            value={ttlDraft ?? String(data?.coinTtlMonths ?? '')}
            onChange={e => setTtlDraft(e.target.value)}
            onBlur={commitTtl}
            onKeyDown={e => { if (e.key === 'Enter') commitTtl(); }}
            className="w-14 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title="Комиссия за перевод MLT коллеге, % — сжигается">
          Комиссия переводов, %
          <SettingsNum value={data?.transferFeePercent ?? 5}
            onCommit={v => saveTransfer.mutate({ feePercent: v })} w="w-12" allowZero />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title="Дневной лимит суммы исходящих переводов на менеджера">
          Лимит переводов/день
          <SettingsNum value={data?.transferDailyLimit ?? 500}
            onCommit={v => saveTransfer.mutate({ dailyLimit: v })} w="w-16" />
        </label>
        <button type="button" onClick={() => setEditing('new')}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white">
          Добавить позицию
        </button>
        <span className="ml-auto inline-flex items-center gap-2">
          {release?.startedAt ? (
            <span className="text-xs text-[var(--color-text-muted)]" title="Одноразовая операция уже выполнена">
              Релизный старт выполнен {release.startedAt}
            </span>
          ) : (
            <button type="button" onClick={() => { setReleaseResult(null); releaseStart.mutate(); }}
              disabled={releaseStart.isPending}
              title="Одноразово: обнулить все ретро-балансы и начислить всем одинаковый старт (полки и рубли не трогаются). Запускается только на официальном релизе!"
              className="rounded-lg border border-[var(--color-negative,#e03131)] px-3 py-1 text-xs font-semibold text-[var(--color-negative,#e03131)] disabled:opacity-50">
              Релизный старт…
            </button>
          )}
          {releaseResult && <span className="text-xs text-[var(--color-text-muted)]">{releaseResult}</span>}
        </span>
      </div>
      <div className="mb-2 text-xs text-[var(--color-text-muted)]">
        Цены — в единицах индексации (сейчас 1 ед = 1 {currencyName}; при вводе индексации витрина пересчитается сама,
        оформленные покупки зафиксированы). Удаления нет — выключайте позицию.
      </div>
      {[...byCat.entries()].map(([cat, list]) => (
        <div key={cat} className="mb-3">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{CAT_LABELS[cat] ?? cat}</div>
          <div className="flex flex-col gap-1.5">
            {list.map(i => (
              <div key={i.id} className={`flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2 ${i.enabled ? '' : 'opacity-60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-[var(--color-text)]">{i.name}</div>
                  {i.description && <div className="text-xs text-[var(--color-text-muted)]">{i.description}</div>}
                </div>
                <span className="inline-flex items-center gap-1 text-xs tabular-nums font-semibold text-[var(--color-accent)]">
                  <MltCoin size={13} title={currencyName} />
                  {i.priceEball.toLocaleString('ru-RU')} {currencyName}
                  {i.priceRub !== null && <span className="ml-1 font-normal text-[var(--color-text-muted)]">/ {i.priceRub.toLocaleString('ru-RU')} ₽</span>}
                </span>
                <span className="text-xs tabular-nums text-[var(--color-text-muted)]" title="сток">{i.stock === null ? '∞' : i.stock}</span>
                <span className="text-xs tabular-nums text-[var(--color-text-muted)]" title="срок годности">{i.ttlMonths} мес</span>
                <span className="text-xs tabular-nums text-[var(--color-text-muted)]" title="покупок">{i.purchases}×</span>
                <button type="button" onClick={() => setEditing(i)}
                  className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs hover:bg-[var(--color-bg-hover)]">
                  Изменить
                </button>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={i.enabled}
                    onChange={e => toggle.mutate({ id: i.id, enabled: e.target.checked })} />
                  вкл
                </label>
              </div>
            ))}
          </div>
        </div>
      ))}
      {editing !== null && (
        <ItemEditor
          item={editing === 'new' ? null : editing}
          currencyName={currencyName}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
        />
      )}
    </div>
  );
}

function SettingsNum({ value, onCommit, w, allowZero }: { value: number; onCommit: (v: number) => void; w: string; allowZero?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const v = Number(draft);
    if (draft === null || !Number.isFinite(v) || (allowZero ? v < 0 : v <= 0) || v === value) { setDraft(null); return; }
    onCommit(v); setDraft(null);
  };
  return (
    <input value={draft ?? String(value)} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); }}
      className={`${w} rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums`} />
  );
}
