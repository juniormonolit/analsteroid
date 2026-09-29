'use client';
// Общая оболочка правой выезжающей панели дрилл-дауна (задача #8126, аудит Полины,
// находки 1, 6): та же геометрия, что у DrilldownDrawer «Продаж» — подложка 10%
// слева (SLIDE_BACKDROP_BG) с язычком закрытия PanelCloseTab, Esc закрывает
// (useEscapeClose, стек панелей), плавное закрытие (useSlideClose), шапка
// «Имя + бейдж метрики» + строка периода, отдельная строка тулбара и слот тела.
// На телефоне — во весь экран, крестик в шапке. Используется списком задач
// «Ответов на запросы» и карточкой заявки «Реализации».

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { useEscapeClose } from '@/lib/hooks/useEscapeClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SLIDE_BACKDROP_BG } from '@/components/ui/SlideBackdrop';

export function SidePanelShell({ title, badge, subtitle, headerExtras, toolbar, children, onClose, ariaLabel }: {
  title: ReactNode;
  /** Бейдж рядом с заголовком — название метрики ячейки, как у DrilldownDrawer. */
  badge?: ReactNode;
  /** Строка под заголовком: период, «N строк» и т.п. */
  subtitle?: ReactNode;
  /** Кнопки справа в шапке (до крестика). */
  headerExtras?: ReactNode;
  /** Строка тулбара под шапкой (период, фильтры). */
  toolbar?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  ariaLabel?: string;
}) {
  const { closing, requestClose } = useSlideClose(onClose);
  useEscapeClose(requestClose);
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <div
        className={`hidden sm:block w-[10%] shrink-0 ${SLIDE_BACKDROP_BG} cursor-pointer slide-backdrop-fade ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={requestClose}
      />
      <PanelCloseTab onClick={requestClose} style={{ left: '10%', transform: 'translateX(-100%)' }} />
      <div className={`flex-1 min-w-0 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <div className="flex items-center justify-between flex-wrap gap-y-2 px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-[var(--color-text)] text-base truncate">
              {title}
              {badge && (
                <span className="ml-2 align-middle inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]">
                  {badge}
                </span>
              )}
            </h2>
            {subtitle && <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center flex-wrap gap-2 sm:gap-3 shrink-0 ml-auto pl-2">
            {headerExtras}
            <button type="button" onClick={requestClose} aria-label="Закрыть"
              className="sm:hidden p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors"><X size={18} /></button>
          </div>
        </div>
        {toolbar && (
          <div className="flex items-center gap-2 px-3 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0 flex-wrap">
            {toolbar}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{children}</div>
      </div>
    </div>
  );
}
