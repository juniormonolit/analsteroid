'use client';

// Рандомайзер косметики (задача 63, п.1). Отдельным блоком на экране
// «Оформление», под каталогом.
//
// Экран обязан показывать три ограничителя механики, а не прятать их: цену
// прокрута, сколько прокрутов осталось сегодня и что незакреплённое вытесняется.
// Без этого человек крутит вслепую и злится, когда понравившийся вариант
// исчезает, — а это ровно та ситуация, ради которой закрепление и вводилось.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Dices, Pin } from 'lucide-react';
import {
  generatedBackground, generatedCover, generatedFrame, type GenKind,
} from '@/lib/profile/generated';
import { backgroundCss } from '@/lib/profile/cosmetics';

interface GenRow { id: number; kind: GenKind; cosmeticId: string; pinned: boolean; createdAt: string }
interface Payload {
  settings: { rollPrice: number; rollsPerDay: number; keepUnpinned: number; pinPrice: number };
  generated: GenRow[];
}

const KINDS: { key: GenKind; label: string }[] = [
  { key: 'frame', label: 'Рамки' },
  { key: 'background', label: 'Фоны' },
  { key: 'cover', label: 'Обложки' },
];

/** Превью варианта — тем же генератором, что и настоящий рендер. */
function Preview({ kind, id }: { kind: GenKind; id: string }) {
  if (kind === 'cover') {
    const c = generatedCover(id);
    return <div className="h-12 w-full rounded-md" style={{ background: c.css, backgroundSize: c.size }} />;
  }
  if (kind === 'frame') {
    const f = generatedFrame(id);
    return (
      <div className="flex h-12 items-center justify-center">
        <div className="rounded-[12px] p-1" style={{ background: f.ring }}>
          <div className="h-8 w-8 rounded-[9px] bg-[var(--color-bg-surface)]" />
        </div>
      </div>
    );
  }
  const bg = backgroundCss(generatedBackground(id));
  return <div className="h-12 w-full rounded-md" style={bg ? { background: bg.background, backgroundSize: bg.backgroundSize } : undefined} />;
}

export function RandomizerBlock({ onEquip }: {
  /** Надеть выпавший вариант — экран «Оформление» знает, как это сделать. */
  onEquip: (kind: GenKind, cosmeticId: string) => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<GenKind>('frame');
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<Payload>({
    queryKey: ['profile-randomizer'],
    queryFn: async () => {
      const res = await fetch('/api/profile/randomizer');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const post = async (body: Record<string, unknown>) => {
    setError(null);
    const res = await fetch('/api/profile/randomizer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    return j;
  };
  const roll = useMutation({
    mutationFn: () => post({ kind }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profile-randomizer'] }),
    onError: e => setError(e instanceof Error ? e.message : 'Ошибка'),
  });
  const pin = useMutation({
    mutationFn: (cosmeticId: string) => post({ action: 'pin', cosmeticId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profile-randomizer'] }),
    onError: e => setError(e instanceof Error ? e.message : 'Ошибка'),
  });

  if (!data) return null;
  const s = data.settings;
  const mine = data.generated.filter(g => g.kind === kind);
  const today = data.generated.filter(g => g.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const left = Math.max(0, s.rollsPerDay - today);

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-sm font-bold text-[var(--color-text)]">🎲 Рандомайзер</h3>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          генерирует вариант, которого больше нет ни у кого
        </span>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {KINDS.map(k => (
          <button
            key={k.key} type="button" onClick={() => setKind(k.key)}
            className={`min-h-11 rounded-lg px-3 text-[13px] sm:min-h-8 ${
              kind === k.key
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button" onClick={() => roll.mutate()} disabled={roll.isPending || left === 0}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white disabled:opacity-40 sm:min-h-9"
        >
          <Dices size={14} /> {roll.isPending ? 'Кручу…' : 'Прокрутить'}
          <span className="inline-flex items-center gap-0.5 opacity-90"><Coins size={12} />{s.rollPrice}</span>
        </button>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          сегодня осталось {left} из {s.rollsPerDay}
        </span>
      </div>

      {error && <div className="mb-2 text-xs text-[var(--color-negative,#e03131)]">{error}</div>}

      {mine.length === 0 ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Пока ничего не выпадало. Прокрут даёт уникальный вариант — он ваш, пока не вытеснится
          новыми. Понравился — закрепите, тогда останется навсегда.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {mine.map(g => (
            <div key={g.id} className="rounded-lg border border-[var(--color-border)] p-1.5">
              <Preview kind={g.kind} id={g.cosmeticId} />
              <div className="mt-1 flex items-center gap-1">
                <button
                  type="button" onClick={() => onEquip(g.kind, g.cosmeticId)}
                  className="min-h-11 flex-1 rounded-md border border-[var(--color-border)] text-[12px] hover:bg-[var(--color-bg-hover)] sm:min-h-8"
                >
                  Надеть
                </button>
                {g.pinned ? (
                  <span className="tap-target inline-flex items-center px-1 text-[var(--color-accent)]" title="Закреплён — не вытесняется">
                    <Pin size={13} />
                  </span>
                ) : (
                  <button
                    type="button" onClick={() => pin.mutate(g.cosmeticId)} disabled={pin.isPending}
                    title={`Закрепить за ${s.pinPrice} MLT — вариант перестанет вытесняться`}
                    className="tap-target inline-flex items-center rounded-md px-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"
                  >
                    <Pin size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-[11px] leading-snug text-[var(--color-text-muted)]">
        Незакреплённые варианты вытесняются новыми — храним последние {s.keepUnpinned} каждого вида.
        Закрепление стоит {s.pinPrice} MLT и оставляет вариант навсегда.
      </p>
    </section>
  );
}
