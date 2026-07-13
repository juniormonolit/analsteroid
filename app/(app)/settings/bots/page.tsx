import Link from 'next/link';
import { Bot, PhoneMissed } from 'lucide-react';

// Список ботов Bitrix24, живущих в Монолитике. «Аналитик» пока без своей страницы
// настроек (расписание/получатель заданы env на сервере) — карточка информационная;
// вынести его настройки в БД — отдельной задачей.
export default function BotsPage() {
  return (
    <div className="p-3 sm:p-6 max-w-3xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Боты</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">
        Чат-боты Bitrix24, которыми управляет аналитика.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="border border-[var(--color-border)] rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Bot size={18} className="text-[var(--color-accent)]" />
            <span className="text-sm font-semibold text-[var(--color-text)]">Аналитик</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Ежедневный отчёт «МОСКВА» в 18:00 МСК в личку владельца. Расписание и
            получатель заданы на сервере (env), настройки в интерфейсе — в планах.
          </p>
        </div>

        <Link
          href="/settings/bots/call-control"
          className="border border-[var(--color-border)] rounded-lg p-4 hover:bg-[var(--color-bg-hover)] transition-colors block"
        >
          <div className="flex items-center gap-2 mb-2">
            <PhoneMissed size={18} className="text-[var(--color-accent)]" />
            <span className="text-sm font-semibold text-[var(--color-text)]">Контроль звонков</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Следит за пропущенными входящими и эскалирует по правилам: менеджер → РОП →
            директор → собственник. Правила и шаблоны настраиваются →
          </p>
        </Link>
      </div>
    </div>
  );
}
