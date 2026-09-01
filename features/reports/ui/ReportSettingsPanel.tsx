'use client';
import { useEffect } from 'react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { useEscapeClose } from '@/lib/hooks/useEscapeClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { FiltersFields, type FiltersFieldsProps } from './FiltersMenu';
import { ViewSettingsFields, type ViewSettingsFieldsProps } from './ViewSettings';

/**
 * Объединённая панель «Настройки отчёта» (правка владельца 09.07) — заменяет две
 * отдельные кнопки-дропдауна основного тулбара отчёта («Фильтры» + «Вид»). Слайдер
 * справа в стиле уже принятой панели настроек метрики (HighlightEditor, немодальный
 * режим): SlideBackdrop + PanelCloseTab + useSlideClose, та же ширина/анимация.
 *
 * Внутри — ДВЕ КОЛОНКИ: слева весь контент «Фильтры» (FiltersFields), справа весь
 * контент «Вид» (ViewSettingsFields) — сама логика/state фильтров и вида НЕ меняются,
 * меняется только контейнер. На мобиле колонки схлопываются в одну (см. `sm:` префиксы).
 *
 * FiltersFields/ViewSettingsFields — те же компоненты, что используют самостоятельные
 * попапы FiltersMenu/ViewSettings в дрилл-дауне (DrilldownDrawer) — там независимые
 * фильтры остаются отдельным дропдауном, не затронуты этой правкой.
 *
 * ПРАВИЛО несохранённых изменений (п.4 правок 09.07/2, ai_docs/fresh_docs/
 * DESIGN_GUIDELINES.md → «Панели с сохранением») здесь НЕ подключено намеренно:
 * у этой панели нет кнопки «Сохранить» — каждый Seg/toggle в FiltersFields/
 * ViewSettingsFields (onDealScopeChange, onClientTypeChange, density, borderMode и
 * т.д.) применяется МГНОВЕННО через колбэки-пропсы прямо в состояние SalesReportPage,
 * закрыть панель (мимо/крестик/Esc) в любой момент нечем «потерять» — уже сохранено.
 * Если сюда когда-нибудь добавят поле со staging-состоянием и явным Save — тогда и
 * подключить `useUnsavedGuard`/`UnsavedChangesDialog`, как в HighlightEditor.
 */
interface Props extends FiltersFieldsProps, ViewSettingsFieldsProps {
  onClose: () => void;
}

export function ReportSettingsPanel({ onClose, ...fields }: Props) {
  const { closing, requestClose } = useSlideClose(onClose);

  // Esc закрывает панель, как и клик по подложке (SlideBackdrop.onClick).
  // Общий стек (правка владельца 31.08): раньше здесь был свой window-обработчик,
  // и при вложенных панелях Esc закрывал и эту, и верхнюю одновременно.
  useEscapeClose(requestClose);

  return (
    <>
      <SlideBackdrop closing={closing} onClick={requestClose} />
      {/* Ширина/анимация — как в HighlightEditor (модалка, немодальный режим настройки
          метрики): ~48vw, мин. 680px, макс. 960px, схлопывается в полную ширину до sm:. */}
      <div
        className={`fixed inset-y-0 right-0 z-50 bg-[var(--color-bg-surface)] shadow-2xl flex flex-col w-full sm:w-[48vw] sm:min-w-[680px] sm:max-w-[960px] ${
          closing ? 'slide-panel-out-right' : 'slide-panel-in-right'
        }`}
      >
        <PanelCloseTab onClick={requestClose} />

        {/* Header */}
        <div className="flex items-start justify-between px-5 sm:px-8 pt-5 sm:pt-6 pb-4 sm:pb-5 border-b border-[var(--color-border)]">
          <div className="font-semibold text-[var(--color-text)] text-base sm:text-lg">Настройки отчёта</div>
          <button onClick={requestClose} className="sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors ml-2 mt-0.5">✕</button>
        </div>

        {/* Body: 2 колонки (Фильтры / Вид), на мобиле — 1 колонка на всю ширину.
            Редизайн 31.08 («каша»): поля собраны в смысловые карточки (FieldsGroup),
            «Тип аккаунтов» больше НЕ дублируется в «Виде» — это фильтр, его место
            слева (в самостоятельном попапе «Вид» дрилл-дауна его и не было). */}
        <div className="flex-1 overflow-y-auto flex flex-col sm:flex-row">
          <div className="flex flex-col sm:w-1/2 sm:border-r sm:border-[var(--color-border)]">
            <div className="px-5 sm:px-6 py-5 sm:py-6">
              <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3.5">Фильтры</div>
              <FiltersFields {...fields} grouped />
            </div>
          </div>
          <div className="flex flex-col sm:w-1/2">
            <div className="px-5 sm:px-6 py-5 sm:py-6">
              <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3.5">Вид</div>
              <ViewSettingsFields {...fields} accountType={undefined} onAccountTypeChange={undefined} grouped />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
