'use client';
// «Доступ по прямой ссылке» (сценарий владельца 05.08): человек зашёл через
// локальное приложение Битрикса, нажал кнопку — получил одноразовую ссылку,
// открыл её в браузере, задал пароль и сохранил приложение на телефон.
//
// Ссылка показывается НА ЭКРАНЕ, а не только шлётся ботом: бот сейчас в режиме
// тишины и молча ничего не доставляет (на этом уже сгорели приглашения новых
// пользователей). Если бот включат — придёт ещё и в чат, о чём скажет подпись.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, Copy, Check, ExternalLink } from 'lucide-react';

export function DirectAccessCard() {
  const [copied, setCopied] = useState(false);

  const get = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/me/direct-access', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Не удалось получить ссылку');
      return json as { link: string; expiresAt: string; sentViaBot: boolean };
    },
  });

  const link = get.data?.link;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-1.5 flex items-center gap-2">
        <KeyRound size={17} className="text-[var(--color-accent)]" />
        <h2 className="text-base font-bold text-[var(--color-text)]">Доступ по прямой ссылке</h2>
      </div>
      <p className="text-[13px] text-[var(--color-text-muted)] max-w-[62ch]">
        Сейчас вы вошли через Битрикс — он узнаёт вас сам. Чтобы открывать кабинет отдельно
        (и сохранить его как приложение на телефоне), задайте себе пароль по одноразовой ссылке.
      </p>

      {!link ? (
        <button
          type="button"
          onClick={() => get.mutate()}
          disabled={get.isPending}
          className="mt-3 min-h-11 rounded-xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-text-inverse)] disabled:opacity-40"
        >
          {get.isPending ? 'Готовим ссылку…' : 'Получить ссылку для пароля'}
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12px] text-[var(--color-text)]">
              {link}
            </code>
            <button
              type="button"
              onClick={() => { void navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="tap-target inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Скопировано' : 'Копировать'}
            </button>
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-[13px] font-semibold text-[var(--color-text-inverse)]"
            >
              <ExternalLink size={15} /> Открыть
            </a>
          </div>
          <p className="text-[12px] text-[var(--color-text-muted)]">
            Ссылка одноразовая и действует 7 дней.
            {get.data?.sentViaBot
              ? ' Она же отправлена вам ботом «Аналитик».'
              : ' Бот сейчас молчит, поэтому скопируйте её отсюда.'}
            {' '}Внутри Битрикса ссылка не откроется — нажмите «Открыть», она выйдет в новую вкладку.
          </p>
        </div>
      )}

      {get.isError && (
        <div className="mt-2 text-[13px] text-[var(--color-negative)]">
          {get.error instanceof Error ? get.error.message : 'Ошибка'}
        </div>
      )}
    </section>
  );
}
