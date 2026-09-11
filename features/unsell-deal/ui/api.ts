'use client';
// Клиентские вызовы «Снять с продажи» (задача #6260).
import type { HydratedDeal } from '@/lib/reports/dealsByIds';
import type { ManualFixRow } from '@/lib/sales/unsellDeal';

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Ошибка ${res.status}`);
  return data as T;
}

export const unsellApi = {
  findDeal: (dealId: number) => fetch(`/api/sales/unsell-deal/${dealId}`).then(r => j<{ deal: HydratedDeal }>(r)),
  unsell: (dealId: number, reason: string) =>
    fetch(`/api/sales/unsell-deal/${dealId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(r => j<{ ok: true }>(r)),
  journal: () => fetch('/api/sales/unsell-deal').then(r => j<{ rows: ManualFixRow[] }>(r)),
};

export const INPUT_CLS = 'w-full border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-60';
export const BTN_PRIMARY = 'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-4 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50';
export const BTN_SECONDARY = 'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-4 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
