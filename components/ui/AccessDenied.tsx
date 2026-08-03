import { ShieldAlert } from 'lucide-react';

/**
 * Единое сообщение «недостаточно прав» (задача 2824, план из аудита
 * `owners-inbox/analsteroid-url-addressability-audit.md`, п.0.2/1.2/1.5/1.6).
 * Правило владельца (Серёга): если прислать коллеге ссылку на закрытый для
 * него раздел, он должен увидеть ВНЯТНОЕ «недостаточно прав», а не молчаливый
 * редирект на другую страницу и не generic 404 (как раньше было у большинства
 * `settings/*` разделов — `redirect('/settings')` без единого слова).
 *
 * Три ХОРОШИХ примера уже существовали в проекте до этой задачи (`/offload`,
 * `/employees`, `/manager/[id]`) — три чуть разных `<div className="p-6 text-sm
 * text-[var(--color-text-muted)]">` с одинаковым по сути содержимым. Этот
 * компонент — их унификация, canon-компонент по тому же принципу, что уже
 * применяется к `Modal`/`Popover` (CLAUDE.md, правила адаптивности 3-4):
 * один компонент, не россыпь копий.
 *
 * Обычный (не клиентский) компонент — рендерится и из серверных
 * `layout.tsx`/`page.tsx` (где и происходит основная часть гейтинга), и из
 * клиентских компонентов (случай API-403 после монтирования, напр.
 * `SubscriptionsPage.tsx`) без разницы в импорте.
 */
export function AccessDenied({
  reason,
  title = 'Недостаточно прав',
}: {
  /** Конкретная причина — «какой раздел», «кому доступно», «как получить доступ». */
  reason: string;
  title?: string;
}) {
  return (
    <div className="h-full flex items-start sm:items-center justify-center p-6">
      <div className="max-w-md flex flex-col items-center text-center gap-3 py-8">
        <div
          className="flex items-center justify-center w-11 h-11 rounded-full shrink-0"
          style={{ backgroundColor: 'color-mix(in srgb, var(--color-negative) 12%, transparent)' }}
        >
          <ShieldAlert size={20} style={{ color: 'var(--color-negative)' }} />
        </div>
        <h1 className="text-base font-semibold text-[var(--color-text)]">{title}</h1>
        <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">{reason}</p>
      </div>
    </div>
  );
}
