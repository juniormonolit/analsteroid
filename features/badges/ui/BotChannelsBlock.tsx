'use client';

// Поканальная глушилка ботов (задача 09.08.2026). Раньше это был флаг в env,
// который правился только на сервере с рестартом — владелец без разработчика не
// мог ни включить, ни выключить ничего.
//
// Экран обязан отвечать на один вопрос: «почему я не получаю уведомления».
// Поэтому у каждого канала видно, какой бот его шлёт и что именно туда попадает,
// а выключенный канал подписан прямо — «сообщения формируются, но не уходят»,
// а не просто серой галочкой.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Bot } from 'lucide-react';

interface Channel {
  key: string; name: string; description: string; bot: string;
  enabled: boolean; updatedAt: string | null; updatedBy: string | null;
}
interface Payload { channels: Channel[]; envOverride: boolean; error?: string }

export function BotChannelsBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<Payload>({
    queryKey: ['bot-channels'],
    queryFn: async () => {
      const res = await fetch('/api/settings/bots/channels');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const toggle = useMutation({
    mutationFn: async (c: Channel) => {
      const res = await fetch('/api/settings/bots/channels', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: c.key, enabled: !c.enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bot-channels'] }),
  });

  if (!data) return null;
  const on = data.channels.filter(c => c.enabled).length;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-base font-bold text-[var(--color-text)]">🔕 Каналы сообщений</h2>
        <span className="text-xs text-[var(--color-text-muted)]">
          включено {on} из {data.channels.length}
        </span>
      </div>
      <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
        Выключенный канал не молчит «внутри»: сообщения по-прежнему считаются и пишутся в
        журнал исходящих, просто не уходят в Битрикс. Поэтому включение задним числом не
        рассылает пропущенное — только то, что случится дальше.
      </p>

      {data.error && (
        <div className="mb-3 rounded-lg border border-[var(--color-border)] p-2 text-xs text-[var(--color-text-muted)]">
          {data.error}
        </div>
      )}
      {data.envOverride && (
        <div className="mb-3 rounded-lg border border-[var(--color-negative,#e03131)] p-2 text-xs text-[var(--color-negative,#e03131)]">
          На сервере поднят аварийный тумблер <code>BOT_SEND_ENABLED=1</code> — шлётся ВСЁ,
          флажки ниже сейчас ничего не решают.
        </div>
      )}

      <div className="flex flex-col gap-2">
        {data.channels.map(c => (
          <label
            key={c.key}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-border)] p-3 hover:bg-[var(--color-bg-hover)]"
          >
            <input
              type="checkbox" checked={c.enabled} onChange={() => toggle.mutate(c)}
              disabled={toggle.isPending}
              className="tap-target mt-0.5 h-4 w-4 shrink-0 cursor-pointer"
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-bold text-[var(--color-text)]">{c.name}</span>
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                  <Bot size={11} /> {c.bot}
                </span>
                {!c.enabled && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-muted)]">
                    <BellOff size={11} /> не уходит в Битрикс
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-[var(--color-text-muted)]">
                {c.description}
              </span>
              {c.updatedBy && (
                <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">
                  менял {c.updatedBy}
                  {c.updatedAt ? ` · ${new Date(c.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      {toggle.isError && (
        <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">
          {toggle.error instanceof Error ? toggle.error.message : 'Ошибка сохранения'}
        </div>
      )}
    </section>
  );
}
