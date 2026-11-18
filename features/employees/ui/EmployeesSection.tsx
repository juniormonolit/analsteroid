'use client';

// Раздел «Сотрудники» (переделка 18.11 по решению владельца): вкладка «Таймлайн» —
// логины по отделам и кто на них сидел (TimelineView, по умолчанию); «Список» —
// прежний реестр (EmployeesPage). Вкладка — в адресе (?tab=list), чтобы ссылка
// открывала нужную. Две вкладки — flex-wrap, без горизонтальной ленты (CLAUDE.md, п.12).

import { useRouter, useSearchParams } from 'next/navigation';
import { EmployeesPage } from './EmployeesPage';
import { TimelineView } from './TimelineView';

const TABS = [
  { key: 'timeline', label: 'Таймлайн' },
  { key: 'list', label: 'Список' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function EmployeesSection() {
  const router = useRouter();
  const params = useSearchParams();
  const tab: TabKey = params.get('tab') === 'list' ? 'list' : 'timeline';
  const setTab = (k: TabKey) => router.replace(k === 'timeline' ? '/employees' : '/employees?tab=list', { scroll: false });

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="p-4 md:p-6">
        <h1 className="mb-2 text-lg font-semibold">Сотрудники</h1>
        <div className="mb-4 flex flex-wrap gap-1 border-b border-[var(--color-border)]">
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`min-h-11 sm:min-h-0 -mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'timeline' ? <TimelineView /> : <EmployeesPage />}
      </div>
    </div>
  );
}
