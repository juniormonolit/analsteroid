import Link from 'next/link';
import { Bot, PhoneMissed } from 'lucide-react';

// Список ботов Bitrix24, живущих в Монолитике. У «Аналитика» с 09.09 своя страница:
// реестр функций (каждая — рубильник + получатели/час) и расписания авторассылки
// сохранённых отчётов — задача владельца «включать, настраивать и выключать каждую
// функцию в настройках».
export default function BotsPage() {
  return (
    <div className="p-3 sm:p-6 max-w-3xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Боты</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">
        Чат-боты Bitrix24, которыми управляет аналитика.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link
          href="/settings/bots/analitik"
          className="border border-[var(--color-border)] rounded-lg p-4 hover:bg-[var(--color-bg-hover)] transition-colors block"
        >
          <div className="flex items-center gap-2 mb-2">
            <Bot size={18} className="text-[var(--color-accent)]" />
            <span className="text-sm font-semibold text-[var(--color-text)]">Аналитик</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Всё, что пишет «Аналитик»: приглашения и служебные ссылки, ежедневные отчёты,
            дайджесты, напоминания, геймификация, чаты по сделкам, опрос по погоде — каждая
            функция включается отдельно; плюс расписания рассылки сохранённых отчётов →
          </p>
        </Link>

        <Link
          href="/settings/bots/call-control"
          className="border border-[var(--color-border)] rounded-lg p-4 hover:bg-[var(--color-bg-hover)] transition-colors block"
        >
          <div className="flex items-center gap-2 mb-2">
            <PhoneMissed size={18} className="text-[var(--color-accent)]" />
            <span className="text-sm font-semibold text-[var(--color-text)]">Контроль звонков</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Отдельный бот с одной функцией: пропущенные входящие и эскалация по правилам
            менеджер → РОП → директор → собственник. Работает всегда, рубильника нет;
            правила и шаблоны →
          </p>
        </Link>

      </div>

    </div>
  );
}
