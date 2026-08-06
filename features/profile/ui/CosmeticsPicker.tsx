'use client';
// Пикер оформления профиля: рамки аватара и эмодзи-фоны за MLT (задача #34).
//
// Устроен как пикер обложек (CoverPicker), но позиции не открываются уровнями,
// а ПОКУПАЮТСЯ. Отсюда два состояния кнопки: «купить за N» и «надеть». Гейт —
// на сервере (/api/profile/cosmetics), здесь только отображение.
//
// Пин при покупке спрашивается по общему порогу трат: если сервер ответил
// pinRequired, показываем поле и повторяем запрос с пином — тот же сценарий,
// что в магазине, отдельного правила для косметики не заводим.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Coins } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { backgroundCss, cosmeticById, type CosmeticKind } from '@/lib/profile/cosmetics';

interface CatalogItem {
  id: string;
  kind: CosmeticKind;
  name: string;
  price: number;
  ring: string | null;
  emoji: string[] | null;
  backdrop: string | null;
  owned: boolean;
}

interface CatalogResponse {
  balance: number;
  storageReady: boolean;
  equipped: { frameId: string; backgroundId: string };
  cosmetics: CatalogItem[];
}

/** Превью: кружок-аватар в рамке поверх эмодзи-подложки. */
function Preview({ item }: { item: CatalogItem }) {
  const def = cosmeticById(item.id);
  const bg = backgroundCss(def);
  return (
    <div
      className="relative flex h-16 w-full items-center justify-center"
      style={bg ? { background: bg.background, backgroundSize: bg.backgroundSize } : undefined}
    >
      <span
        className="flex h-10 w-10 items-center justify-center rounded-full p-[3px]"
        style={{ background: item.ring ?? 'transparent' }}
      >
        <span className="h-full w-full rounded-full bg-[var(--color-bg-surface)]" />
      </span>
    </div>
  );
}

function Section({ title, items, equippedId, balance, onBuy, onEquip, busy }: {
  title: string;
  items: CatalogItem[];
  equippedId: string;
  balance: number;
  onBuy: (id: string) => void;
  onEquip: (item: CatalogItem) => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-[var(--color-text-muted)]">{title}</span>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {items.map(item => {
          const active = equippedId === item.id;
          const affordable = item.owned || balance >= item.price;
          return (
            <div
              key={item.id}
              className={`relative flex flex-col overflow-hidden rounded-xl border ${
                active ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]' : 'border-[var(--color-border)]'
              }`}
            >
              <Preview item={item} />
              {active && (
                <div className="absolute right-1.5 top-1.5 rounded-full bg-[var(--color-accent)] p-0.5">
                  <Check size={12} className="text-[var(--color-text-inverse)]" />
                </div>
              )}
              <div className="flex flex-col gap-1 bg-[var(--color-bg-surface)] px-2 py-1.5">
                <span className="text-[12px] font-semibold leading-tight text-[var(--color-text)]">{item.name}</span>
                {item.owned ? (
                  <button
                    type="button"
                    disabled={busy || active}
                    onClick={() => onEquip(item)}
                    className="min-h-11 rounded-lg border border-[var(--color-border)] text-[12px] disabled:opacity-40"
                  >
                    {active ? 'Надето' : 'Надеть'}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy || !affordable}
                    onClick={() => onBuy(item.id)}
                    title={affordable ? undefined : 'Не хватает MLT'}
                    className="min-h-11 inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--color-accent)] text-[12px] font-medium text-white disabled:opacity-40"
                  >
                    <Coins size={12} /> {item.price}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CosmeticsPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState('');

  const { data } = useQuery({
    queryKey: ['cosmetics-catalog'],
    queryFn: async () => {
      const res = await fetch('/api/profile/cosmetics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<CatalogResponse>;
    },
    enabled: open,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cosmetics-catalog'] });
    // Аватар с рамкой и баланс живут в других запросах.
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
    void qc.invalidateQueries({ queryKey: ['wallet'] });
  };

  const buy = useMutation({
    mutationFn: async ({ id, pinCode }: { id: string; pinCode?: string }) => {
      const res = await fetch('/api/profile/cosmetics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'buy', id, ...(pinCode ? { pin: pinCode } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.pinRequired) {
          // Не ошибка, а второй шаг: просим пин и повторяем ту же покупку.
          setPinFor(id);
          throw new Error('Подтвердите покупку пин-кодом');
        }
        throw new Error(json.error ?? 'Не удалось купить');
      }
      return id;
    },
    onSuccess: () => { setError(null); setPinFor(null); setPin(''); refresh(); },
    onError: e => setError(e instanceof Error ? e.message : String(e)),
  });

  const equip = useMutation({
    mutationFn: async (item: CatalogItem) => {
      const field = item.kind === 'frame' ? 'frameId' : 'backgroundId';
      const res = await fetch('/api/profile/cosmetics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'equip', [field]: item.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Не удалось надеть');
      return json;
    },
    onSuccess: () => { setError(null); refresh(); },
    onError: e => setError(e instanceof Error ? e.message : String(e)),
  });

  const items = data?.cosmetics ?? [];
  const busy = buy.isPending || equip.isPending;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Оформление профиля">
      <div className="flex flex-col gap-4 p-1">
        <div className="flex items-center gap-1.5 text-sm">
          <Coins size={14} className="text-[var(--color-text-muted)]" />
          <span className="text-[var(--color-text-muted)]">На балансе:</span>
          <span className="font-semibold tabular-nums">{data?.balance ?? 0}</span>
        </div>

        {error && <div className="text-xs text-[var(--color-negative)]">{error}</div>}

        {pinFor && (
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-2">
            <span className="text-xs text-[var(--color-text-muted)]">Покупка требует подтверждения пин-кодом</span>
            <div className="flex gap-2">
              <input
                value={pin}
                onChange={e => setPin(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Пин-код"
                className="min-h-11 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm"
              />
              <button
                type="button"
                disabled={!pin.trim() || busy}
                onClick={() => buy.mutate({ id: pinFor, pinCode: pin.trim() })}
                className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white disabled:opacity-50"
              >
                Подтвердить
              </button>
            </div>
          </div>
        )}

        {data && !data.storageReady && (
          <div className="text-xs text-[var(--color-text-muted)]">
            Оформление ещё не включено — не применена миграция 157. Каталог показан, покупка недоступна.
          </div>
        )}

        <Section
          title="Рамка аватара"
          items={items.filter(i => i.kind === 'frame')}
          equippedId={data?.equipped.frameId ?? ''}
          balance={data?.balance ?? 0}
          onBuy={id => buy.mutate({ id })}
          onEquip={item => equip.mutate(item)}
          busy={busy}
        />
        <Section
          title="Фон профиля"
          items={items.filter(i => i.kind === 'background')}
          equippedId={data?.equipped.backgroundId ?? ''}
          balance={data?.balance ?? 0}
          onBuy={id => buy.mutate({ id })}
          onEquip={item => equip.mutate(item)}
          busy={busy}
        />

        <p className="text-[11px] text-[var(--color-text-muted)]">
          Купленное остаётся навсегда — можно переодеваться сколько угодно. Списание идёт
          из того же баланса MLT, что и покупки в магазине.
        </p>
      </div>
    </Modal>
  );
}
