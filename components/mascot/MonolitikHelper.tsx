'use client';
import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Monolitik, type MonolitikPose } from './Monolitik';

/**
 * «Скрепка из Word»: Монолитик + облачко с заголовком, текстом и
 * необязательным прогрессом. Два варианта размещения:
 *  - inline — встраивается в блок (вкладка «ИИ-анализ» в карточке клиента);
 *  - corner — закреплён в правом нижнем углу экрана поверх контента.
 *
 * Крестик: если передан onClose — решает родитель (например, убирает
 * помощника совсем). Без onClose облачко сворачивается, робот остаётся;
 * клик по роботу разворачивает облачко обратно. Смена позы (новый этап)
 * разворачивает облачко сама — как скрепка, у которой появилось что сказать.
 *
 * Адаптивность чистым CSS: на телефоне робот меньше, облачко сжимается по
 * ширине экрана, в углу учитываются safe-area (PWA/iPhone). Ветвления по
 * режиму запуска (useAppMode) не нужно — поведение одинаково во всех четырёх.
 */
export interface MonolitikHelperProps {
  pose: MonolitikPose;
  title: ReactNode;
  text?: ReactNode;
  /** 0–100 — полоса с процентом; 'indeterminate' — бегущая полоса; не задан — без полосы. */
  progress?: number | 'indeterminate';
  placement?: 'inline' | 'corner';
  /** С какой стороны от облачка стоит робот. */
  side?: 'left' | 'right';
  /** Кнопки/ссылки под текстом облачка. */
  actions?: ReactNode;
  onClose?: () => void;
  /** false — без крестика. */
  closable?: boolean;
  className?: string;
}

export function MonolitikHelper({
  pose,
  title,
  text,
  progress,
  placement = 'inline',
  side = 'right',
  actions,
  onClose,
  closable = true,
  className,
}: MonolitikHelperProps) {
  // Любая смена позы = новый этап = облачко снова видно (сброс прямо в рендере,
  // без эффекта — паттерн «состояние от предыдущего пропа» из доков React).
  const [collapsed, setCollapsed] = useState(false);
  const [prevPose, setPrevPose] = useState(pose);
  if (pose !== prevPose) {
    setPrevPose(pose);
    setCollapsed(false);
  }
  const open = !collapsed;

  const close = () => {
    if (onClose) onClose();
    else setCollapsed(true);
  };

  const pct = typeof progress === 'number' ? Math.max(0, Math.min(100, progress)) : null;
  const robotLeft = side === 'left';

  const bubble = open && (
    <div
      className="mlk-bubble-in relative min-w-0 flex-1 sm:flex-none sm:w-80 max-w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] shadow-[var(--shadow-lg)] px-3.5 py-3 mb-4"
      role="status"
      aria-live="polite"
    >
      {/* хвостик облачка — смотрит на робота */}
      <span
        aria-hidden
        className={`absolute bottom-5 h-3.5 w-3.5 bg-[var(--color-bg-surface)] border-[var(--color-border)] ${
          robotLeft ? '-left-[7.5px] border-l border-b rotate-45' : '-right-[7.5px] border-r border-b -rotate-45'
        }`}
      />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-snug">{title}</div>
          {text && <div className="mt-0.5 text-sm leading-snug text-[var(--color-text-muted)]">{text}</div>}
        </div>
        {closable && (
          <button
            type="button"
            onClick={close}
            aria-label="Скрыть подсказку"
            className="tap-target -mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {progress !== undefined && (
        <div className="mt-2.5 flex items-center gap-2">
          <div
            className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-bg-hover)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${pct === null ? 'mlk-bar-indeterminate w-2/5' : ''}`}
              style={{
                width: pct === null ? undefined : `${pct}%`,
                background: 'linear-gradient(90deg, #ff9a1f, #ffc83d)',
              }}
            />
          </div>
          {pct !== null && (
            <span className="w-9 text-right text-xs tabular-nums text-[var(--color-text-muted)]">{Math.round(pct)}%</span>
          )}
        </div>
      )}

      {actions && <div className="mt-2.5 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );

  const figure = <Monolitik pose={pose} size={96} className="h-[90px] w-[72px] sm:h-[120px] sm:w-24" />;
  // Свёрнутый робот — кнопка «развернуть облачко»; при открытом облачке просто рисунок.
  const robot = open ? (
    <div className="shrink-0">{figure}</div>
  ) : (
    <button
      type="button"
      onClick={() => setCollapsed(false)}
      aria-label="Показать подсказку Монолитика"
      className="shrink-0 cursor-pointer rounded-xl transition-transform hover:scale-105"
    >
      {figure}
    </button>
  );

  const content = (
    <div className={`flex items-end gap-2 ${robotLeft ? 'flex-row-reverse' : ''}`}>
      {bubble}
      {robot}
    </div>
  );

  if (placement === 'corner') {
    return (
      <div
        className={`fixed z-50 max-w-[calc(100vw-16px)] ${className ?? ''}`}
        style={{
          right: 'max(8px, env(safe-area-inset-right))',
          bottom: 'calc(8px + env(safe-area-inset-bottom))',
        }}
      >
        {content}
      </div>
    );
  }

  return <div className={`min-w-0 max-w-full ${className ?? ''}`}>{content}</div>;
}
