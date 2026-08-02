'use client';
// Личные настройки дайджеста «Аналитика» по отделу — только для РОПов (задача
// 2769, продолжение 2765). По образцу BotSubscriptionSettings.tsx: API берёт
// bitrixId из сессии (app/api/me/rop-bot-prefs/route.ts), применяется
// немедленно. Блок скрывает себя целиком, если у пользователя сейчас нет ни
// одного прямого подчинённого (isRop=false) — директору/админу без своего
// отдела показывать нечего.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';

interface RopPrefs { enabled: boolean; dailyDigest: boolean; weeklyDigest: boolean; showNumbers: boolean; showHints: boolean }
interface Payload { prefs: RopPrefs; hasBitrix: boolean; isRop: boolean }

export function RopDigestSettings() {
  const qc = useQueryClient();
  const { data } = useQuery<Payload>({
    queryKey: ['me-rop-bot-prefs'],
    queryFn: async () => {
      const res = await fetch('/api/me/rop-bot-prefs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const patch = useMutation({
    mutationFn: async (body: Partial<RopPrefs>) => {
      const res = await fetch('/api/me/rop-bot-prefs', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ prefs: RopPrefs }>;
    },
    onSuccess: (d) => qc.setQueryData<Payload>(['me-rop-bot-prefs'], old => old ? { ...old, prefs: d.prefs } : old),
  });

  if (!data || !data.hasBitrix || !data.isRop) return null;
  const p = data.prefs;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-2">
        <Users size={15} className="text-[var(--color-text-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Дайджест «Аналитика» по отделу</h2>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        Агрегированный дайджест твоего отдела — цифры отдела и управленческие подсказки. Персональные
        подсказки/переписку менеджеров с ботом здесь не увидишь — только показатели, которые ты и так видишь
        в отчётах и на вкладке «Моя команда».
      </p>

      <label className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
        <span className="text-sm font-medium">Получать дайджест отдела</span>
        <input type="checkbox" checked={p.enabled} onChange={e => patch.mutate({ enabled: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
      </label>

      <div className={`flex flex-col gap-2.5 ${!p.enabled ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mt-1">Когда</div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Ежедневный дайджест (короткий, будни)</span>
          <input type="checkbox" checked={p.dailyDigest} onChange={e => patch.mutate({ dailyDigest: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Еженедельный дайджест (итоги, по понедельникам)</span>
          <input type="checkbox" checked={p.weeklyDigest} onChange={e => patch.mutate({ weeklyDigest: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
        </label>

        <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mt-2">Что показывать</div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Цифры и тренды отдела (гамбургер)</span>
          <input type="checkbox" checked={p.showNumbers} onChange={e => patch.mutate({ showNumbers: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Управленческие подсказки (конверсия, брони, заказчики)</span>
          <input type="checkbox" checked={p.showHints} onChange={e => patch.mutate({ showHints: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
        </label>
      </div>
    </div>
  );
}
