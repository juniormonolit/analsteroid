// Честная заглушка «нет данных» (правило владельца 05.08: «если аккаунт не
// относится по оргструктуре к отделу продаж — должно быть всё то же самое, но
// где нет данных, так и написать: нет данных»). Применяется и к сотрудникам вне
// продаж (маркетинг, снабжение, логистика, HR — 100+ человек по оргструктуре),
// и к обычным пустым периодам: показывать нули там, где цифр просто нет, —
// вводить человека в заблуждение.
export function NoData({ what, hint }: {
  /** Чего именно нет: «продаж», «заказчиков», «плана на месяц». */
  what?: string;
  /** Необязательное пояснение, почему пусто. */
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-6 text-center">
      <span className="text-sm font-semibold text-[var(--color-text-muted)]">
        Нет данных{what ? ` — ${what}` : ''}
      </span>
      {hint && <span className="text-[12px] text-[var(--color-text-muted)] max-w-[42ch]">{hint}</span>}
    </div>
  );
}
