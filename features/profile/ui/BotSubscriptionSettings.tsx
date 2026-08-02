'use client';
// Личные настройки подписки на бота «Аналитик» (задача 2765, правка владельца
// 02.08): «менеджер должен понимать — общение с аналитиком это его личка...
// возможно стоит дать менеджеру в ЛК ещё и власть над ним». ТОЛЬКО свои
// настройки — API берёт bitrixId из сессии (см. app/api/me/bot-prefs/route.ts),
// применяются немедленно. РОП/админ эти настройки НЕ видят и не могут менять —
// это принципиально (см. комментарий в notifications.ts).
//
// Финансовые уведомления (переводы/начисления/выплаты/сгорание валюты) сюда
// НЕ входят — они идут отдельным путём и не отключаются никогда.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';

interface Prefs { enabled: boolean; dailyDigest: boolean; weeklyDigest: boolean; adviceCustomers: boolean; adviceNumbers: boolean }
interface Payload { prefs: Prefs; hasBitrix: boolean }

export function BotSubscriptionSettings() {
  const qc = useQueryClient();
  const { data } = useQuery<Payload>({
    queryKey: ['me-bot-prefs'],
    queryFn: async () => {
      const res = await fetch('/api/me/bot-prefs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const patch = useMutation({
    mutationFn: async (body: Partial<Prefs>) => {
      const res = await fetch('/api/me/bot-prefs', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ prefs: Prefs }>;
    },
    onSuccess: (d) => qc.setQueryData<Payload>(['me-bot-prefs'], old => old ? { ...old, prefs: d.prefs } : old),
  });

  if (!data) return null;
  if (!data.hasBitrix) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5 text-sm text-[var(--color-text-muted)]">
        К аккаунту не привязан Bitrix — настройки бота «Аналитик» недоступны.
      </div>
    );
  }
  const p = data.prefs;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-2">
        <Bell size={15} className="text-[var(--color-text-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Бот «Аналитик»</h2>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        Это твоя личка с ботом — сам решаешь, что получать. Отключение ничего не меняет в рейтинге,
        наградах и XP — на них это никак не влияет. РОП и руководство не видят, что именно ты тут отключил.
      </p>

      <label className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-[var(--color-border)]">
        <span className="text-sm font-medium">Получать сообщения от Аналитика</span>
        <input type="checkbox" checked={p.enabled} onChange={e => patch.mutate({ enabled: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
      </label>

      {!p.enabled && (
        <div className="mb-3 rounded-lg bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          Полностью выключено. Если не хочешь совсем без связи — попробуй оставить только «реже»:
          <button
            type="button"
            onClick={() => patch.mutate({ enabled: true, dailyDigest: false, weeklyDigest: true })}
            className="ml-2 rounded border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-bg-hover)]"
          >
            включить «реже» (только раз в неделю)
          </button>
        </div>
      )}

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
          <span>Подсказки по заказчикам (кому позвонить)</span>
          <input type="checkbox" checked={p.adviceCustomers} onChange={e => patch.mutate({ adviceCustomers: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Цифры и тренды</span>
          <input type="checkbox" checked={p.adviceNumbers} onChange={e => patch.mutate({ adviceNumbers: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
        </label>
      </div>

      <p className="mt-4 text-[11px] text-[var(--color-text-muted)]">
        Уведомления о деньгах (переводы, начисления, выплаты, сгорание валюты) сюда не относятся — они
        приходят всегда, это важно не пропустить.
      </p>
    </div>
  );
}
