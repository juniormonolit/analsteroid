'use client';
// Лента профиля (задача владельца 05.08, этап 2 ЛК-соцсетки): «посты-события» —
// получена награда / выполнен квест / крупная продажа, чтобы профиль был живым.
// Показывается и в своём ЛК, и в публичном профиле (ProfileTab), данные —
// GET /api/profile/feed (собирается на лету, хранимой ленты нет).
import { useQuery } from '@tanstack/react-query';

interface FeedEvent {
  type: 'badge' | 'quest' | 'sale' | 'level' | 'first_sale';
  ts: string;
  title: string;
  emoji: string;
  tier: string | null;
  amount: number | null;
  subtitle: string | null;
}

// Тиры наград (бейджи) и квестов — русские подписи + цвета, совпадают с
// принятыми в полке наград/квестах.
const TIERS: Record<string, { label: string; color: string }> = {
  bronze: { label: 'Бронза', color: '#b45309' },
  silver: { label: 'Серебро', color: '#94a3b8' },
  gold: { label: 'Золото', color: '#f59e0b' },
  platinum: { label: 'Платина', color: '#7da7d9' },
  white: { label: 'Обычный', color: '#9ca3af' },
  green: { label: 'Необычный', color: '#2f9e44' },
  blue: { label: 'Редкий', color: '#1c7ed6' },
  epic: { label: 'Эпический', color: '#9c36b5' },
  legendary: { label: 'Легендарный', color: '#e8590c' },
};

const TYPE_LABEL: Record<FeedEvent['type'], string> = {
  badge: 'Получена награда',
  quest: 'Выполнен квест',
  sale: 'Крупная продажа',
  level: 'Новый уровень',
  first_sale: 'Первая продажа в группе',
};

function fmtFeedDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function fmtAmount(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  return `${Math.round(v / 1000).toLocaleString('ru-RU')} тыс ₽`;
}

export function ProfileFeed({ managerId }: { managerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['profile-feed', managerId],
    queryFn: async () => {
      const res = await fetch(`/api/profile/feed?bitrixId=${encodeURIComponent(managerId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ events: FeedEvent[] }>;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const events = data?.events ?? [];

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Лента</div>
      {isLoading ? (
        <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>
      ) : events.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">Пока тихо — награды, квесты и крупные продажи появятся здесь.</div>
      ) : (
        <div className="flex flex-col">
          {events.map((e, i) => {
            const tier = e.tier ? TIERS[e.tier] : null;
            return (
              <div key={`${e.type}-${e.ts}-${i}`} className="flex items-start gap-3 py-2.5 border-b border-[var(--color-border)] last:border-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg)] text-lg">
                  {e.emoji}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[12px] font-semibold text-[var(--color-text-muted)]">{TYPE_LABEL[e.type]}</span>
                    <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums ml-auto shrink-0">{fmtFeedDate(e.ts)}</span>
                  </div>
                  <div className="text-sm text-[var(--color-text)] break-words">
                    {e.type === 'sale' && e.amount !== null && (
                      <b className="tabular-nums">{fmtAmount(e.amount)}</b>
                    )}
                    {e.type === 'sale' ? <> — {e.title}</> : e.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 flex-wrap">
                    {tier && (
                      <span
                        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                        style={{ color: tier.color, backgroundColor: `${tier.color}1a` }}
                      >
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
      )}
    </section>
  );
}
