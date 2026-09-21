'use client';

// Кнопка входа из окна Битрикса в обычную вкладку (инцидент 21.09).
//
// Обычная ссылка target="_blank" работает, пока iframe портала не заперт
// sandbox без allow-popups. На такой случай — запасной путь: если новую
// вкладку открыть не дали, уводим ВЕСЬ верхний фрейм на наш адрес (это
// разрешено по клику пользователя). Лучше выйти из портала в кабинет, чем
// упереться в кнопку, которая молча ничего не делает.
export function EnterButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => {
        const w = window.open(href, '_blank', 'noopener');
        e.preventDefault();
        if (w) return;
        try {
          if (window.top) window.top.location.href = href;
          else window.location.href = href;
        } catch {
          window.location.href = href;      // верхний фрейм чужой и закрыт — уходим хотя бы сами
        }
      }}
      className="min-h-11 inline-flex items-center rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-sm font-semibold text-[var(--color-text-inverse)] hover:opacity-90"
    >
      {children}
    </a>
  );
}
