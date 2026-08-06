'use client';
// Вкладка «Оформление» в настройках кабинета: обложка, рамка аватара и фон
// профиля — в одном месте, с ПРИМЕРКОЙ.
//
// Две правки владельца 06.08 задают всё устройство экрана:
//   1. «Почему не вынести обложку и так далее в настройки в оформление? там
//      выбираешь всё спокойно с превьюшкой» — раздел переехал сюда из двух
//      модалок на обложке. Обложка, рамка и фон — ОДНО решение «как выглядит мой
//      профиль», и раньше их СОЧЕТАНИЕ увидеть было нельзя: каждая модалка
//      превьюила только себя.
//   2. «Ты по сути сделал функцию продажи оформления БЕЗ примерки. Сделай выбор
//      в табах по типу элемента и зафиксируй превью, чтобы скроллить только
//      варианты» — отсюда три вещи ниже.
//
// ПРИМЕРКА. Клик по варианту не сохраняет и не покупает НИЧЕГО — только меняет
// превью, включая некупленное и незаработанное. На сервер уходит лишь
// «Применить», и только для того, что человеку принадлежит. Покупка — отдельная
// кнопка на плитке, то есть потратить MLT можно лишь увидев, как это выглядит.
//
// ПРЕВЬЮ ЗАКРЕПЛЕНО (sticky): скроллится сетка вариантов, а не превью — иначе
// примерка требует прокрутки вверх после каждого клика.
//
// ТАБЫ по типу элемента: три сетки подряд давали страницу, где превью и варианты
// одновременно на экране не удержать.
//
// Превью собрано ТЕМИ ЖЕ coverStyle/backgroundCss/ring, что рендерят настоящую
// шапку профиля — разъехаться превью и реальности неоткуда.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Coins, Eye, Lock, RotateCcw } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { coverStyle } from '@/lib/profile/covers';
import { backgroundCss, cosmeticById, type CosmeticKind } from '@/lib/profile/cosmetics';

interface CoverItem { id: string; name: string; unlocked: boolean; requirement: string | null }
interface CosmeticItem {
  id: string; kind: CosmeticKind; name: string; price: number;
  ring: string | null; emoji: string[] | null; backdrop: string | null; owned: boolean;
}

type Slot = 'cover' | 'frame' | 'background';
const TABS: { key: Slot; label: string }[] = [
  { key: 'cover', label: 'Обложка' },
  { key: 'frame', label: 'Рамка' },
  { key: 'background', label: 'Фон' },
];

export function AppearanceSettings({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [tab, setTab] = useState<Slot>('cover');
  const [tryOn, setTryOn] = useState<Partial<Record<Slot, string>>>({});

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

  const coverList = covers.data?.covers ?? [];
  const items = cosmetics.data?.cosmetics ?? [];

  // Что сохранено на сервере и что примерено сейчас.
  const saved: Record<Slot, string | undefined> = {
    cover: covers.data?.coverId,
    frame: cosmetics.data?.equipped.frameId,
    background: cosmetics.data?.equipped.backgroundId,
  };
  const shown: Record<Slot, string | undefined> = {
    cover: tryOn.cover ?? saved.cover,
    frame: tryOn.frame ?? saved.frame,
    background: tryOn.background ?? saved.background,
  };

  const frameRing = cosmeticById(shown.frame)?.ring ?? null;
  const shownBg = backgroundCss(cosmeticById(shown.background));

  /** Можно ли НАДЕТЬ примеренное: обложку — если открыта, косметику — если куплена. */
  const availability = useMemo(() => {
    const check = (slot: Slot): { ok: boolean; reason: string | null } => {
      const id = tryOn[slot];
      if (!id) return { ok: true, reason: null }; // не примеряли — нечего применять
      if (slot === 'cover') {
        const c = coverList.find(x => x.id === id);
        if (!c) return { ok: false, reason: 'обложка не найдена' };
        return c.unlocked ? { ok: true, reason: null } : { ok: false, reason: `обложка «${c.name}» ещё не открыта` };
      }
      const it = items.find(x => x.id === id);
      if (!it) return { ok: false, reason: 'вариант не найден' };
      // Некупленное НЕ блокирует: кнопка ниже покупает и применяет одним кликом
      // (правка владельца 06.08). Блокирует только незаработанная обложка — её
      // за MLT не купить, она открывается уровнем класса XP.
      return { ok: true, reason: null };
    };
    const results = (['cover', 'frame', 'background'] as Slot[]).map(s => ({ slot: s, ...check(s) }));
    return {
      dirty: (['cover', 'frame', 'background'] as Slot[]).some(s => tryOn[s] && tryOn[s] !== saved[s]),
      blockers: results.filter(r => !r.ok).map(r => r.reason).filter((v): v is string => !!v),
    };
  }, [tryOn, coverList, items, saved.cover, saved.frame, saved.background]);

  // Что из примеренного ещё не куплено и во сколько это встанет.
  const toBuy = (['frame', 'background'] as Slot[])
    .map(slot => tryOn[slot])
    .filter((id): id is string => !!id)
    .map(id => items.find(x => x.id === id))
    .filter((it): it is CosmeticItem => !!it && !it.owned);
  const totalPrice = toBuy.reduce((sum, it) => sum + it.price, 0);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cosmetics-catalog'] });
    void qc.invalidateQueries({ queryKey: ['cover-catalog'] });
    // Шапку профиля кормит этот же запрос — иначе примерка применится, а шапка
    // останется прежней до перезагрузки страницы.
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  const apply = useMutation({
    // «Купить за столько-то и применить» одной кнопкой (правка владельца 06.08:
    // «чтобы можно было выбрать комбинацию и в один клик купить и применить»).
    // Порядок важен: сначала покупки, потом надевание — сервер не даст надеть
    // то, чем человек ещё не владеет.
    mutationFn: async (pinCode?: string) => {
      for (const it of toBuy) {
        const res = await fetch('/api/profile/cosmetics', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'buy', id: it.id, ...(pinCode ? { pin: pinCode } : {}) }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (json.pinRequired) { setPinFor('apply'); throw new Error('Подтвердите покупку пин-кодом'); }
          throw new Error(json.error ?? `Не удалось купить «${it.name}»`);
        }
      }
      // Обложка и косметика — разные ручки; отправляем только изменённое.
      if (tryOn.cover && tryOn.cover !== saved.cover) {
        const res = await fetch('/api/profile/cover', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coverId: tryOn.cover }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? 'Не удалось сменить обложку');
      }
      const body: Record<string, string> = {};
      if (tryOn.frame && tryOn.frame !== saved.frame) body.frameId = tryOn.frame;
      if (tryOn.background && tryOn.background !== saved.background) body.backgroundId = tryOn.background;
      if (Object.keys(body).length > 0) {
        const res = await fetch('/api/profile/cosmetics', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'equip', ...body }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? 'Не удалось применить');
      }
    },
    onSuccess: () => { setError(null); setTryOn({}); setPinFor(null); setPin(''); refresh(); },
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
    // Примерку НЕ сбрасываем: человек купил то, что уже на превью, — логично
    // оставить это надетым в примерке и дать нажать «Применить».
    onSuccess: () => { setError(null); setPinFor(null); setPin(''); refresh(); },
    onError: e => setError(e instanceof Error ? e.message : String(e)),
  });

  const busy = apply.isPending || buy.isPending;
  const balance = cosmetics.data?.balance ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {/* ── Закреплённое превью + управление примеркой ── */}
      <div className="sticky top-0 z-10 -mx-3 flex flex-col gap-2 bg-[var(--color-bg)] px-3 pb-2 pt-1 sm:-mx-6 sm:px-6">
        <section className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <div className="h-24 w-full" style={coverStyle(shown.cover)} />
          {/* Фон рисуется ОТДЕЛЬНЫМ слоем от top-10 вниз, а не фоном самого
              блока (баг со скрина владельца «выбор кастомного фона меняет
              верстку»): блок поднят на -mt-10, и его собственный фон закрашивал
              эти 40px обложки — при выборе фона обложка визуально становилась
              ниже. Слой начинается там, где обложка заканчивается. */}
          <div className="relative -mt-10 px-4 pb-3">
            {shownBg && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 top-10"
                style={{ background: shownBg.background, backgroundSize: shownBg.backgroundSize }}
              />
            )}
            <div className="relative">
            <div className="flex flex-col items-center gap-1.5 text-center">
              <div className="rounded-[14px] p-1" style={frameRing ? { background: frameRing } : undefined}>
                <div className={`rounded-[11px] shadow-md ${frameRing ? '' : 'ring-4 ring-[var(--color-bg-surface)]'}`}>
                  <Avatar name={name} url={avatarUrl} size={80} shape="rounded" />
                </div>
              </div>
              <span className="text-sm font-semibold text-[var(--color-text)]">{name}</span>
            </div>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm">
            <Coins size={14} className="text-[var(--color-text-muted)]" />
            <span className="text-[var(--color-text-muted)]">Баланс:</span>
            <span className="font-semibold tabular-nums">{balance}</span>
          </span>
          <span className="ml-auto flex items-center gap-2">
            {availability.dirty && (
              <button
                type="button"
                onClick={() => { setTryOn({}); setError(null); }}
                className="tap-target inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm"
              >
                <RotateCcw size={13} /> Сбросить
              </button>
            )}
            <button
              type="button"
              disabled={!availability.dirty || availability.blockers.length > 0 || busy || totalPrice > balance}
              onClick={() => apply.mutate(undefined)}
              title={totalPrice > balance ? 'Не хватает MLT' : undefined}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-40"
            >
              {apply.isPending
                ? (toBuy.length > 0 ? 'Покупаю…' : 'Применяю…')
                : totalPrice > 0
                  ? `Купить за ${totalPrice} и применить`
                  : 'Применить'}
            </button>
          </span>
        </div>

        {availability.dirty && availability.blockers.length === 0 && (
          <p className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
            <Eye size={12} /> Это примерка — на профиле пока прежнее оформление.
          </p>
        )}
        {totalPrice > 0 && totalPrice > balance && (
          <p className="text-[12px] text-[var(--color-negative)]">
            На примерку нужно {totalPrice} MLT, на балансе {balance}. Снимите часть выбора или заработайте.
          </p>
        )}
        {availability.blockers.length > 0 && (
          <p className="text-[12px] text-[var(--color-text-muted)]">
            Примерка: {availability.blockers.join(', ')}. Купите или откройте — тогда можно применить.
          </p>
        )}
        {error && <p className="text-sm text-[var(--color-negative)]">{error}</p>}
      </div>

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
              onClick={() => (pinFor === 'apply' ? apply.mutate(pin.trim()) : buy.mutate({ id: pinFor, pinCode: pin.trim() }))}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              Подтвердить
            </button>
          </div>
        </div>
      )}

      {cosmetics.data && !cosmetics.data.storageReady && (
        <p className="text-[12px] text-[var(--color-text-muted)]">
          Покупка оформления пока недоступна — не применена миграция 157. Примерять можно.
        </p>
      )}

      {/* ── Табы по типу элемента ── */}
      <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`min-h-11 flex-1 text-sm transition-colors ${
              tab === t.key
                ? 'bg-[var(--color-accent)] font-medium text-white'
                : 'bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'cover' && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {coverList.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => setTryOn(p => ({ ...p, cover: c.id }))}
              title={c.unlocked ? c.name : `Откроется: ${c.requirement}`}
              className={`relative flex flex-col overflow-hidden rounded-xl border text-left ${
                shown.cover === c.id
                  ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]'
                  : 'border-[var(--color-border)] hover:shadow-md'
              }`}
            >
              {/* Заблокированную обложку МОЖНО примерить — замочек говорит лишь,
                  что применить её пока нельзя. Это и есть смысл примерки. */}
              <div className="h-14 w-full" style={coverStyle(c.id)} />
              {!c.unlocked && (
                <span className="absolute right-1.5 top-1.5 rounded-full bg-black/45 p-1">
                  <Lock size={11} className="text-white" />
                </span>
              )}
              {saved.cover === c.id && (
                <span className="absolute left-1.5 top-1.5 rounded-full bg-[var(--color-accent)] p-0.5">
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
          ))}
        </div>
      )}

      {(tab === 'frame' || tab === 'background') && (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {items.filter(i => i.kind === tab).map(item => {
            const tried = shown[tab] === item.id;
            const isSaved = saved[tab] === item.id;
            const bg = backgroundCss(cosmeticById(item.id));
            return (
              <div
                key={item.id}
                className={`relative flex flex-col overflow-hidden rounded-xl border ${
                  tried ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]' : 'border-[var(--color-border)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setTryOn(p => ({ ...p, [tab]: item.id }))}
                  title={`Примерить: ${item.name}`}
                  className="flex h-14 items-center justify-center"
                  style={bg ? { background: bg.background, backgroundSize: bg.backgroundSize } : undefined}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full p-[3px]" style={{ background: item.ring ?? 'transparent' }}>
                    <span className="h-full w-full rounded-full bg-[var(--color-bg-surface)]" />
                  </span>
                </button>
                {isSaved && (
                  <span className="absolute left-1.5 top-1.5 rounded-full bg-[var(--color-accent)] p-0.5">
                    <Check size={11} className="text-[var(--color-text-inverse)]" />
                  </span>
                )}
                <div className="flex flex-col gap-1 px-2 py-1.5">
                  <span className="text-[12px] font-semibold leading-tight">{item.name}</span>
                  {item.owned ? (
                    <span className="min-h-11 flex items-center text-[11px] text-[var(--color-text-muted)]">
                      {isSaved ? 'Надето' : 'Куплено'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || balance < item.price}
                      onClick={() => buy.mutate({ id: item.id })}
                      title={balance >= item.price ? `Купить за ${item.price}` : 'Не хватает MLT'}
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
      )}

      <p className="text-[11px] text-[var(--color-text-muted)]">
        Примерять можно всё, включая некупленное. Купленное остаётся навсегда — переодеваться
        сколько угодно. Списание идёт из того же баланса MLT, что и покупки в магазине.
      </p>
    </div>
  );
}
