'use client';
// Пикер обложки профиля (ЛК-соцсетка, этап 2): сетка превью из каталога
// lib/profile/covers.ts; заблокированные — с замком и условием («„Кровля“ 10 ур.»).
// Реальный гейт — на сервере (POST /api/profile/cover), тут только отображение.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Check } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { coverStyle } from '@/lib/profile/covers';

interface CatalogItem { id: string; name: string; unlocked: boolean; requirement: string | null }

export function CoverPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['cover-catalog'],
    queryFn: async () => {
      const res = await fetch('/api/profile/cover');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ coverId: string; covers: CatalogItem[] }>;
    },
    enabled: open,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const setCover = useMutation({
    mutationFn: async (coverId: string) => {
      const res = await fetch('/api/profile/cover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Не удалось сменить обложку');
      return coverId;
    },
    onSuccess: () => {
      setError(null);
      // Обложка приезжает через /api/badges/profile (queryKey badges-profile-extra) и каталог.
      void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
      void qc.invalidateQueries({ queryKey: ['cover-catalog'] });
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Обложка профиля">
      <div className="flex flex-col gap-3 p-1">
        {error && <div className="text-xs text-[var(--color-negative)]">{error}</div>}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {(data?.covers ?? []).map(c => {
            const active = data?.coverId === c.id;
            return (
              <button
                key={c.id}
                disabled={!c.unlocked || setCover.isPending}
                onClick={() => setCover.mutate(c.id)}
                className={`group relative flex flex-col rounded-xl border overflow-hidden text-left transition-shadow ${
                  active ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]' : 'border-[var(--color-border)]'
                } ${c.unlocked ? 'hover:shadow-md cursor-pointer' : 'cursor-not-allowed'}`}
                title={c.unlocked ? c.name : `Откроется: ${c.requirement}`}
              >
                <div className={`h-16 w-full ${c.unlocked ? '' : 'opacity-40 saturate-50'}`} style={coverStyle(c.id)} />
                {!c.unlocked && (
                  <div className="absolute inset-x-0 top-0 h-16 flex items-center justify-center">
                    <Lock size={18} className="text-[var(--color-text)] opacity-70" />
                  </div>
                )}
                {active && (
                  <div className="absolute right-1.5 top-1.5 rounded-full bg-[var(--color-accent)] p-0.5">
                    <Check size={12} className="text-[var(--color-text-inverse)]" />
                  </div>
                )}
                <div className="px-2 py-1.5 min-h-11 flex flex-col justify-center bg-[var(--color-bg-surface)]">
                  <span className="text-[12px] font-semibold text-[var(--color-text)] leading-tight">{c.name}</span>
                  {!c.unlocked && c.requirement && (
                    <span className="text-[10px] text-[var(--color-text-muted)] leading-tight">{c.requirement}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Тематические обложки открываются уровнями классов XP — качайте товарные группы.
        </p>
      </div>
    </Modal>
  );
}
