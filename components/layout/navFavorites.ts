'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// «Избранное» пунктов «Ещё» (задача владельца 27.11): пункты, отмеченные звёздочкой в «Ещё»,
// дублируются в основное меню (туда, где раньше стояли «Графики»), порядок — свой у каждого.
// Хранится на аккаунте — users.ui_prefs.navFavorites (эндпоинт /api/me/ui-prefs, миграция 258),
// чтобы меню совпадало на телефоне и десктопе. Значение — href пунктов «Ещё» в нужном порядке.
//
// Нет ключа → DEFAULT_NAV_FAVORITES. Ключ есть (даже пустой массив) → только свой список:
// новые дефолты того, кто хоть раз менял избранное, не трогают. Пункт без прав в меню не
// рисуется (фильтр по moreItems в AppShell), но из сохранённого списка не стирается.
export const DEFAULT_NAV_FAVORITES: string[] = [
  '/tasker', // правка владельца 27.11: «в избранное всем "задачник" поставь»
  '/repeat-kanban',
  '/big-deals-kanban',
  '/logist-kanban',
  '/rop-kanban',
  '/big-brother',
  '/dismissal',
];

const QK = ['me', 'ui-prefs', 'navFavorites'] as const;

/** Список избранного (href по порядку). undefined — ещё грузится: не рисуем, чтобы не мигал дефолт. */
export function useNavFavorites() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: QK,
    queryFn: async (): Promise<string[]> => {
      const r = await fetch('/api/me/ui-prefs', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json() as { prefs?: { navFavorites?: unknown } };
      const v = j.prefs?.navFavorites;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : DEFAULT_NAV_FAVORITES;
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  // Ошибка чтения — показываем дефолт, а не пустоту.
  const favorites = q.data ?? (q.isError ? DEFAULT_NAV_FAVORITES : undefined);

  const m = useMutation({
    mutationFn: async (next: string[]) => {
      const r = await fetch('/api/me/ui-prefs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ navFavorites: next }),
      });
      if (!r.ok) throw new Error(String(r.status));
    },
    // Оптимистично: звезда/порядок меняются сразу, при ошибке — откат.
    onMutate: async next => {
      await qc.cancelQueries({ queryKey: QK });
      const prev = qc.getQueryData<string[]>(QK);
      qc.setQueryData(QK, next);
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(QK, ctx.prev); },
  });

  const base = favorites ?? DEFAULT_NAV_FAVORITES;
  return {
    favorites,
    isFavorite: (href: string) => base.includes(href),
    toggle: (href: string) => m.mutate(base.includes(href) ? base.filter(h => h !== href) : [...base, href]),
    /** Новый порядок ВИДИМЫХ избранных; невидимые (нет прав) остаются в списке на своих местах. */
    reorderVisible: (visibleOrder: string[]) => {
      const set = new Set(visibleOrder);
      let i = 0;
      m.mutate(base.map(h => (set.has(h) ? visibleOrder[i++] : h)));
    },
  };
}
