'use client';
import { useRef, useState } from 'react';
import { Download, Copy, FileSpreadsheet, FileText, Image as ImageIcon, Check, Loader2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';

// Задача 1706 (владелец, экспорт отчёта): кнопка «Копировать» тулбара заменена на
// «Скачать» с выпадающим меню из 4 пунктов. Дропдаун — на общем `components/ui/Popover`
// (см. CLAUDE.md проекта: «Дропдауны/поповеры — только components/ui/Popover», не
// самописное позиционирование и не сырой @radix-ui/react-dropdown-menu — он в
// зависимостях, но неиспользуемый, проект стандартизировался на Popover раньше).
export interface ExportMenuAction {
  key: 'copy' | 'xlsx' | 'pdf' | 'png';
  label: string;
  icon: React.ReactNode;
  run: () => Promise<void>;
}

interface Props {
  onCopyTable: () => Promise<void>;
  onExportExcel: () => Promise<void>;
  onExportPdf: () => Promise<void>;
  onExportPng: () => Promise<void>;
  disabled?: boolean;
}

export function ExportMenu({ onCopyTable, onExportExcel, onExportPdf, onExportPng, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const actions: ExportMenuAction[] = [
    { key: 'copy', label: 'Копировать в буфер', icon: <Copy size={13} />, run: onCopyTable },
    { key: 'xlsx', label: 'Скачать Excel (.xlsx)', icon: <FileSpreadsheet size={13} />, run: onExportExcel },
    { key: 'pdf', label: 'Скачать PDF', icon: <FileText size={13} />, run: onExportPdf },
    { key: 'png', label: 'Скачать PNG', icon: <ImageIcon size={13} />, run: onExportPng },
  ];

  async function handleClick(action: ExportMenuAction) {
    if (busyKey) return;
    setBusyKey(action.key);
    try {
      await action.run();
      setDoneKey(action.key);
      if (doneTimer.current) clearTimeout(doneTimer.current);
      doneTimer.current = setTimeout(() => setDoneKey(null), 1500);
    } catch (e) {
      // Экспорт не должен молча проглатывать ошибку (тот же урок, что и с сохранением
      // отчёта — см. handleSaveReport в SalesReportPage.tsx): пользователь должен узнать,
      // что скачивание/копирование не удалось, а не решить, что просто «ничего не
      // произошло».
      alert(`Не удалось выполнить «${action.label}»: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`);
    } finally {
      setBusyKey(null);
      // Пункт «Копировать» закрывает меню сразу же (как раньше закрывалась одиночная
      // кнопка «Копировать» — обратная связь через смену иконки триггера была видна и
      // без меню). Скачивания оставляют меню открытым — можно скачать сразу несколько
      // форматов подряд, не переоткрывая «Скачать».
      if (action.key === 'copy') setOpen(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-56 p-1"
      trigger={
        <button
          disabled={disabled}
          title="Скачать или скопировать таблицу отчёта"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-60 disabled:pointer-events-none"
        >
          <Download size={12} />
          Скачать
        </button>
      }
    >
      <div className="flex flex-col" data-testid="export-menu-list">
        {actions.map(action => {
          const isBusy = busyKey === action.key;
          const isDone = doneKey === action.key;
          return (
            <button
              key={action.key}
              type="button"
              disabled={!!busyKey}
              onClick={() => handleClick(action)}
              data-testid={`export-menu-item-${action.key}`}
              className="flex items-center gap-2 px-2.5 py-2 text-xs text-left rounded-md text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-60"
            >
              <span className="w-4 flex-shrink-0 flex items-center justify-center text-[var(--color-text-muted)]">
                {isBusy ? <Loader2 size={13} className="animate-spin" /> : isDone ? <Check size={13} className="text-[var(--color-positive)]" /> : action.icon}
              </span>
              {isDone ? (action.key === 'copy' ? 'Скопировано' : 'Скачано') : action.label}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
