'use client';
// Ссылка-приглашение на экране у админа.
//
// Зачем: приглашение уходило ТОЛЬКО сообщением бота. В режиме тишины до релиза
// бот молчит по определению, и приглашение терялось молча — админ видел
// «пользователь создан», человек не получал ничего, и никто не понимал, почему
// нет доступа. Теперь ссылка всегда на экране, и её можно передать руками.
//
// Показывать ссылку админу безопасно: это одноразовый токен на установку
// пароля со сроком 7 дней, а не пароль. Пароли в открытом виде мы не
// пересылаем нигде и никогда.
//
// Аудит 29.09 (#8256): при ПОВТОРНОЙ отправке существующей учётке ссылку видит
// только супер-админ (иначе «Администратор» выключал чужую учётку, переприглашал
// и входил под ней). Без ссылки блок показывает только статус доставки.

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function InviteLinkNotice({ link, delivered, name }: {
  /** Нет ссылки — API её не отдал (повторное приглашение не супер-админом). */
  link?: string | null;
  delivered: boolean;
  /** Кому приглашение — чтобы админ не перепутал, если приглашает нескольких. */
  name?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-3 ${
      delivered
        ? 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'
        : 'border-[var(--color-warning,var(--color-negative))] bg-[var(--color-bg-surface)]'
    }`}>
      <span className="text-[13px] font-semibold text-[var(--color-text)]">
        {delivered
          ? `Приглашение отправлено в Битрикс${name ? ` — ${name}` : ''}`
          : `Бот не доставил приглашение${name ? ` — ${name}` : ''}`}
      </span>
      <span className="text-[12px] leading-snug text-[var(--color-text-muted)]">
        {!link
          ? (delivered
            ? 'Если человек скажет, что ничего не приходило — ссылку может выдать супер-админ.'
            : 'Скорее всего бот в режиме тишины. Ссылку приглашения может выдать супер-админ.')
          : delivered
            ? 'Если человек скажет, что ничего не приходило — передайте ссылку сами. Одноразовая, действует 7 дней.'
            : 'Скорее всего бот в режиме тишины. Передайте ссылку сами — она рабочая, одноразовая, действует 7 дней.'}
      </span>
      {link && <div className="flex items-center gap-2">
        {/* break-all — токен длинный (два UUID) и без переноса растягивал модалку
            за край экрана на 375px. */}
        <code className="min-w-0 flex-1 break-all rounded bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-text)]">
          {link}
        </code>
        <button
          type="button"
          onClick={copy}
          className="tap-target min-h-11 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[13px]"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>}
    </div>
  );
}
