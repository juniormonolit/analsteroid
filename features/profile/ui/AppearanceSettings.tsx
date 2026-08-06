'use client';
// Вкладка «Оформление» в настройках кабинета: обложка, рамка аватара и фон —
// в одном месте, с живым превью всей карточки (предложение владельца 06.08:
// «почему не вынести обложку и так далее в настройки в оформление? там
// выбираешь всё спокойно с превьюшкой и всё»).
//
// Почему это лучше прежних двух модалок с кнопок на обложке:
//   * обложка, рамка и фон — ОДНО решение «как выглядит мой профиль», и раньше
//     нельзя было увидеть их СОЧЕТАНИЕ: каждая модалка превьюила только себя, и
//     что золотая рамка на фоне «Космос» выглядит дёшево, человек узнавал уже
//     после применения;
//   * кнопки жили в самой хрупкой точке макета — полосе обложки, куда налезает
//     поднятое на -mt-20 тело карточки. Это уже дало живой баг «не нажимается»
//     (06.08) и на 375px наезжало на аватар;
//   * места для сетки превью в модалке нет, а здесь колонка настроек.
//
// Превью — НЕ картинка и не отдельная вёрстка «на глазок»: те же самые
// coverStyle/backgroundCss/ring, что рендерят настоящую шапку. Разъехаться
// превью и реальности неоткуда.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Coins, Lock } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { coverStyle } from '@/lib/profile/covers';
import { backgroundCss, cosmeticById, type CosmeticKind } from '@/lib/profile/cosmetics';

interface CoverItem { id: string; name: string; unlocked: boolean; requirement: string | null }
interface CosmeticItem {
  id: string; kind: CosmeticKind; name: string; price: number;
  ring: string | null; emoji: string[] | null; backdrop: string | null; owned: boolean;
}

export function AppearanceSettings({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState('');

  const covers = useQuery({
    queryKey: ['cover-catalog'],
    queryFn: async () => {
      const res = await fetch('/api/profile/cover');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ coverId: string; covers: CoverItem[] }>;
    },
    staleTime: 60_000,
  });

  const cosmetics = useQuery({
    queryKey: ['cosmetics-catalog'],
    queryFn: async () => {
      const res = await fetch('/api/profile/cosmetics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        balance: number; storageReady: boolean;
        equipped: { frameId: string; backgroundId: string };
        cosmetics: CosmeticItem[];
      }>;
    },
    staleTime: 30_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cosmetics-catalog'] });
    void qc.invalidateQueries({ queryKey: ['cover-catalog'] });
    // Шапка карточки читает оформление отсюда — иначе превью и профиль разойдутся.
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  const setCover = useMutation({
    mutationFn: async (coverId: string) => {
      const res = await fetch('/api/profile/cover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Не удалось сменить обложку');
    },
    onSuccess: () => { setError(null); refresh(); },
    onError: e => setError(e instanceof Error ? e.message : String(e)),
  });

  const equip = useMutation({
    mutationFn: async (item: CosmeticItem) => {
      const field = item.kind === 'frame' ? 'frameId' : 'backgroundId';
      const res = await fetch('/api/profile/cosmetics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'equip', [field]: item.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Не удалось надеть');
    },
    onSuccess: () => { setError(null); refresh(); },
    onError: e => setError(e instanceof Error ? e.message : String(e)),
  });

  const buy = useMutation({
    mutationFn: async ({ id, pinCode }: { id: string; pinCode?: string }) => {
      const res = await fetch('/api/profile/cosmetics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'buy', id, ...(pinCode ? { pin: pinCode } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.pinRequired) { setPinFor(id); throw new Error('Подтвердите покупку пин-кодом'); }
        throw new Error(json.error ?? 'Не удалось купить');
      }
    },
    onSuccess: () => { setError(null); setPinFor(null); setPin(''); refresh(); },
    onError: e => setError(e instanceof Error ? e.message : String(e)),
  });

  const equipped = cosmetics.data?.equipped;
  const frameRing = cosmeticById(equipped?.frameId)?.ring ?? null;
  const previewBg = backgroundCss(cosmeticById(equipped?.backgroundId));
  const items = cosmetics.data?.cosmetics ?? [];
  const busy = buy.isPending || equip.isPending || setCover.isPending;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Живое превью: та же вёрстка, что настоящая шапка ── */}
      <section className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <div className="h-28 w-full" style={coverStyle(covers.data?.coverId)} />
        <div
          className="-mt-12 px-4 pb-4"
          style={previewBg ? { background: previewBg.background, backgroundSize: previewBg.backgroundSize } : undefined}
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="rounded-[16px] p-1" style={frameRing ? { background: frameRing } : undefined}>
              <div className={`rounded-[13px] shadow-md ${frameRing ? '' : 'ring-4 ring-[var(--color-bg-surface)]'}`}>
                <Avatar name={name} url={avatarUrl} size={96} shape="rounded" />
              </div>
            </div>
            <span className="text-sm font-semibold text-[var(--color-text)]">{name}</span>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-1.5 text-sm">
        <Coins size={14} className="text-[var(--color-text-muted)]" />
        <span className="text-[var(--color-text-muted)]">На балансе:</span>
        <span className="font-semibold tabular-nums">{cosmetics.data?.balance ?? 0}</span>
      </div>

      {error && <p className="text-sm text-[var(--color-negative)]">{error}</p>}

      {pinFor && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3">
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

      {cosmetics.data && !cosmetics.data.storageReady && (
        <p className="text-[12px] text-[var(--color-text-muted)]">
          Покупка оформления пока недоступна — не применена миграция 157. Каталог показан.
        </p>
      )}

      {/* ── Обложка ── */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Обложка</h2>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {(covers.data?.covers ?? []).map(c => {
            const active = covers.data?.coverId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                disabled={!c.unlocked || busy}
                onClick={() => setCover.mutate(c.id)}
                title={c.unlocked ? c.name : `Откроется: ${c.requirement}`}
                className={`relative flex flex-col overflow-hidden rounded-xl border text-left ${
                  active ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]' : 'border-[var(--color-border)]'
                } ${c.unlocked ? 'cursor-pointer hover:shadow-md' : 'cursor-not-allowed'}`}
              >
                <div className={`h-14 w-full ${c.unlocked ? '' : 'opacity-40 saturate-50'}`} style={coverStyle(c.id)} />
                {!c.unlocked && (
                  <span className="absolute inset-x-0 top-0 flex h-14 items-center justify-center">
                    <Lock size={16} className="opacity-70" />
                  </span>
                )}
                {active && (
                  <span className="absolute right-1.5 top-1.5 rounded-full bg-[var(--color-accent)] p-0.5">
                    <Check size={11} className="text-[var(--color-text-inverse)]" />
                  </span>
                )}
                <span className="min-h-11 flex flex-col justify-center px-2 py-1.5">
                  <span className="text-[12px] font-semibold leading-tight">{c.name}</span>
                  {!c.unlocked && c.requirement && (
                    <span className="text-[10px] leading-tight text-[var(--color-text-muted)]">{c.requirement}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Тематические обложки открываются уровнями классов XP — качайте товарные группы.
        </p>
      </section>

      <CosmeticGroup
        title="Рамка аватара"
        items={items.filter(i => i.kind === 'frame')}
        equippedId={equipped?.frameId}
        balance={cosmetics.data?.balance ?? 0}
        busy={busy}
        onBuy={id => buy.mutate({ id })}
        onEquip={item => equip.mutate(item)}
      />
      <CosmeticGroup
        title="Фон профиля"
        items={items.filter(i => i.kind === 'background')}
        equippedId={equipped?.backgroundId}
        balance={cosmetics.data?.balance ?? 0}
        busy={busy}
        onBuy={id => buy.mutate({ id })}
        onEquip={item => equip.mutate(item)}
      />

      <p className="text-[11px] text-[var(--color-text-muted)]">
        Купленное остаётся навсегда — переодеваться можно сколько угодно. Списание идёт
        из того же баланса MLT, что и покупки в магазине.
      </p>
    </div>
  );
}

function CosmeticGroup({ title, items, equippedId, balance, busy, onBuy, onEquip }: {
  title: string;
  items: CosmeticItem[];
  equippedId: string | undefined;
  balance: number;
  busy: boolean;
  onBuy: (id: string) => void;
  onEquip: (item: CosmeticItem) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {items.map(item => {
          const active = equippedId === item.id;
          const bg = backgroundCss(cosmeticById(item.id));
          const affordable = item.owned || balance >= item.price;
          return (
            <div
              key={item.id}
              className={`relative flex flex-col overflow-hidden rounded-xl border ${
                active ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]' : 'border-[var(--color-border)]'
              }`}
            >
              <div
                className="flex h-14 items-center justify-center"
                style={bg ? { background: bg.background, backgroundSize: bg.backgroundSize } : undefined}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full p-[3px]" style={{ background: item.ring ?? 'transparent' }}>
                  <span className="h-full w-full rounded-full bg-[var(--color-bg-surface)]" />
                </span>
              </div>
              {active && (
                <span className="absolute right-1.5 top-1.5 rounded-full bg-[var(--color-accent)] p-0.5">
                  <Check size={11} className="text-[var(--color-text-inverse)]" />
                </span>
              )}
              <div className="flex flex-col gap-1 px-2 py-1.5">
                <span className="text-[12px] font-semibold leading-tight">{item.name}</span>
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
    </section>
  );
}
