'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Users, Package, ChevronRight } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';

/**
 * «Создать отчёт» (задача 1572, Серёга): стартовые сущности пустого отчёта.
 * Расширяемо на будущее — «По клиентам» уже проектировался Серёгой, но по его
 * же просьбе НЕ показываем в UI, пока сущность не готова на бэкенде. Когда
 * появится — добавить строку сюда, ничего больше менять не нужно (роутинг и
 * пустое состояние SalesReportPage уже общие для любого reportSlug).
 */
export const NEW_REPORT_ENTITIES: { slug: string; label: string; description: string; icon: React.ReactNode }[] = [
  { slug: 'by-managers', label: 'По менеджерам', description: 'Пустой отчёт с разбивкой по менеджерам', icon: <Users size={16} /> },
  { slug: 'by-product-groups', label: 'По товарным группам', description: 'Пустой отчёт с разбивкой по товарным группам', icon: <Package size={16} /> },
  // 'По клиентам' — будущая сущность, см. WORKLOG 10.07 — сознательно скрыта.
];

/**
 * Кнопка + диалог выбора стартовой сущности. Один компонент — два места
 * вызова (Главная, сайдбар), см. HomeReportColumns.tsx и AppShell.tsx.
 * По клику на сущность — переход на её страницу с ?new=1: SalesReportPage
 * сама открывает пустой отчёт в режиме редактирования (без сохранённого
 * пресета), см. заметку в SalesReportPage.tsx.
 */
export function CreateReportButton({
  className,
  label = 'Создать отчёт',
  iconSize = 14,
}: {
  className?: string;
  label?: string;
  iconSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  function pick(slug: string) {
    setOpen(false);
    router.push(`/sales/${slug}?new=1`);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <Plus size={iconSize} />
        {label}
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Создать отчёт" desktopWidth="sm:max-w-[420px]">
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          С чего начать? Метрики добавите после — сущность потом не поменять.
        </p>
        <div className="flex flex-col gap-2">
          {NEW_REPORT_ENTITIES.map(e => (
            <button
              key={e.slug}
              type="button"
              onClick={() => pick(e.slug)}
              className="tap-target flex items-center gap-3 text-left border border-[var(--color-border)] rounded-lg px-3.5 py-3 hover:bg-[var(--color-bg-hover)] hover:border-[var(--color-accent)] transition-colors"
            >
              <span className="shrink-0 text-[var(--color-accent)]">{e.icon}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-[var(--color-text)]">{e.label}</span>
                <span className="block text-[11.5px] text-[var(--color-text-muted)]">{e.description}</span>
              </span>
              <ChevronRight size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}
