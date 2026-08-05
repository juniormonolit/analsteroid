'use client';
// «Движуха» (задача владельца 05.08): общая новостная лента компании. Все
// продажи — компактными «комментариями», крупные — гип-постами по нарастающей
// (3/5/10/20 млн ₽; на 20+ — ликование «неадекватного уровня», формулировка
// владельца), плюс награды и выполненные квесты всех. Сверху закреплён топ-3
// продаж дня (вытеснение при перебитии, отсечка 18:00, награда в конце дня —
// существующие бейджи «Топ продаж»).
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

interface PulseEvent {
  type: 'sale' | 'badge' | 'quest';
  ts: string;
  managerId: string;
  managerName: string;
  department: string | null;
  title: string;
  emoji: string;
  tier: string | null;
  amount: number | null;
  subtitle: string | null;
  hype: 'plain' | 'notable' | 'big' | 'mega' | 'insane' | null;
}
interface PulseResponse { events: PulseEvent[]; topToday: PulseEvent[]; hasDept: boolean }

const TIERS: Record<string, { label: string; color: string }> = {
  bronze: { label: 'Бронза', color: '#b45309' }, silver: { label: 'Серебро', color: '#94a3b8' },
  gold: { label: 'Золото', color: '#f59e0b' }, platinum: { label: 'Платина', color: '#7da7d9' },
  white: { label: 'Обычный', color: '#9ca3af' }, green: { label: 'Необычный', color: '#2f9e44' },
  blue: { label: 'Редкий', color: '#1c7ed6' }, epic: { label: 'Эпический', color: '#9c36b5' },
  legendary: { label: 'Легендарный', color: '#e8590c' },
};

const fmtMoney = (v: number) => v >= 1_000_000
  ? `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`
  : `${Math.round(v / 1000).toLocaleString('ru-RU')} тыс ₽`;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const day = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  if (day === today) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// Гип-тексты по порогам (формулировки согласованы с владельцем 05.08 — на
// insane-уровне текст сознательно «неадекватный», это и был запрос).
function hypeText(e: PulseEvent): { text: string; cls: string; style?: React.CSSProperties } | null {
  const name = e.managerName;
  const money = fmtMoney(e.amount ?? 0);
  const group = e.subtitle ? ` по «${e.subtitle}»` : '';
  switch (e.hype) {
    case 'notable':
      return { text: `🔥 ${name} закрыл сделку на ${money}${group}! Вот это нереальная крутота!`, cls: 'border-orange-300', style: { backgroundColor: 'color-mix(in srgb, #e8590c 7%, transparent)' } };
    case 'big':
      return { text: `🚀 ${name} ЗАТАЩИЛ ${money}${group}! Мощно, снимаем шляпу!`, cls: 'border-orange-400', style: { backgroundColor: 'color-mix(in srgb, #e8590c 12%, transparent)' } };
    case 'mega':
      return { text: `💥💥 ДЕСЯТОЧКА!!! ${name.toUpperCase()} ЗАКРЫЛ ${money.toUpperCase()} ОДНИМ ЧЕКОМ${group.toUpperCase()}!!! ЭТО ПРОСТО КОСМОС!!!`, cls: 'border-red-400', style: { backgroundColor: 'color-mix(in srgb, #e03131 10%, transparent)' } };
    case 'insane':
      return {
        text: `🏆🏆🏆 ВОТ ЭТО ДААААА!!!11111!!11!! ЭТО КТО ЭТО ЧЕМПИОН МИРА ПО ПРОДАЖАМ?! ЭТО ${name.toUpperCase()} ЕБАНУЛ ОДНИМ ЧЕКОМ НА НЕРЕАЛЬНЫЕ ${money.toUpperCase()}${group.toUpperCase()}!!!!!!!!!! КТО РЯДОМ С НИМ СЕЙЧАС — БЕГИТЕ СКОРЕЙ К НЕМУ И ПЕРЕДАЙТЕ ПЯТЮНЮ!!1!!!11!!`,
        cls: 'border-purple-400',
        style: { background: 'linear-gradient(120deg, color-mix(in srgb, #9c36b5 14%, transparent), color-mix(in srgb, #e8590c 14%, transparent))' },
      };
    default:
      return null;
  }
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function PulsePage() {
  const [scope, setScope] = useState<'company' | 'dept'>('company');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pulse', scope],
    queryFn: async () => {
      const res = await fetch(`/api/profile/pulse?scope=${scope}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<PulseResponse>;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const events = data?.events ?? [];
  const top = data?.topToday ?? [];

  return (
    <div className="mx-auto w-full max-w-[860px] p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-extrabold text-[var(--color-text)]">⚡ Движуха</h1>
        {data?.hasDept && (
          <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
            {([['company', 'Вся компания'], ['dept', 'Мой отдел']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setScope(key)}
                className={`px-3 min-h-9 transition-colors whitespace-nowrap ${
                  scope === key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                }`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ══ Закреплённый топ-3 дня ══ */}
      <section className="rounded-2xl border-2 border-[var(--color-top1-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-bold text-[var(--color-text)]">📌 Топ продаж дня</h2>
          <span className="text-[11px] text-[var(--color-text-muted)]">перебил — скинул с пьедестала · отсечка 18:00 · награда в конце дня</span>
        </div>
        {top.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">Пьедестал пуст — первая продажа дня займёт золото 🥇</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {top.map((e, i) => (
              <div key={`${e.managerId}-${i}`} className={`flex flex-wrap items-center gap-2.5 rounded-xl px-3 py-2 ${i === 0 ? 'bg-[var(--color-top1-bg)]' : 'bg-[var(--color-bg)]'}`}>
                <span className="text-xl">{MEDALS[i]}</span>
                <Link href={`/profile/${e.managerId}`} className="text-sm font-bold text-[var(--color-text)] hover:underline">
                  {e.managerName}
                </Link>
                <span className="text-[12px] text-[var(--color-text-muted)] truncate max-w-[40%]">{e.subtitle ?? e.title}</span>
                <span className="ml-auto text-sm font-extrabold tabular-nums text-[var(--color-text)]">{fmtMoney(e.amount ?? 0)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ══ Лента ══ */}
      {isLoading && <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Загрузка движухи…</div>}
      {isError && <div className="py-8 text-center text-sm text-[var(--color-negative)]">Не удалось загрузить ленту</div>}
      <div className="flex flex-col gap-2">
        {events.map((e, i) => {
          const hype = e.type === 'sale' ? hypeText(e) : null;
          if (hype) {
            return (
              <div key={i} className={`rounded-2xl border-2 px-4 py-3 ${hype.cls}`} style={hype.style}>
                <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                  <Link href={`/profile/${e.managerId}`} className="font-semibold text-[var(--color-text)] hover:underline">{e.managerName}</Link>
                  {e.department && <span>· {e.department}</span>}
                  <span className="ml-auto tabular-nums">{fmtWhen(e.ts)}</span>
                </div>
                <div className={`font-bold text-[var(--color-text)] ${e.hype === 'insane' ? 'text-base leading-snug' : 'text-sm'}`}>{hype.text}</div>
              </div>
            );
          }
          if (e.type === 'sale') {
            // «Обычный комментарий»: компактная строка.
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-1.5 text-[12px]">
                <span aria-hidden>💬</span>
                <Link href={`/profile/${e.managerId}`} className="font-semibold text-[var(--color-text)] hover:underline">{e.managerName}</Link>
                <span className="text-[var(--color-text-muted)]">продажа {fmtMoney(e.amount ?? 0)}{e.subtitle ? ` · ${e.subtitle}` : ''}</span>
                <span className="ml-auto tabular-nums text-[var(--color-text-muted)]">{fmtWhen(e.ts)}</span>
              </div>
            );
          }
          const tier = e.tier ? TIERS[e.tier] : null;
          return (
            <div key={i} className="flex items-start gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg)] text-lg">{e.emoji}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                  <Link href={`/profile/${e.managerId}`} className="font-semibold text-[var(--color-text)] hover:underline">{e.managerName}</Link>
                  {e.department && <span>· {e.department}</span>}
                  <span className="ml-auto tabular-nums shrink-0">{fmtWhen(e.ts)}</span>
                </div>
                <div className="text-sm text-[var(--color-text)]">
                  <span className="text-[12px] font-semibold text-[var(--color-text-muted)] mr-1.5">
                    {e.type === 'badge' ? 'получил награду' : 'выполнил квест'}
                  </span>
                  {e.title}
                </div>
                <div className="mt-0.5 flex items-center gap-2 flex-wrap">
                  {tier && (
                    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{ color: tier.color, backgroundColor: `${tier.color}1a` }}>
                      {tier.label}
                    </span>
                  )}
                  {e.subtitle && <span className="text-[11px] text-[var(--color-text-muted)]">{e.subtitle}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
