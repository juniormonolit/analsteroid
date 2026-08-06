'use client';
// Часы анимированной сборки: крутят план (engine/animation.ts) через rAF.
//
// Вся логика «что показать на момент t» живёт в движке и покрыта тестами; здесь
// только время. Так анимацию можно чинить, не запуская браузер.
//
// Кнопки «Пропустить» НЕТ — решение владельца: сборка это способ показа отчёта,
// а не заставка. Единственное исключение — prefers-reduced-motion: системная
// настройка доступности (движение вызывает укачивание), её ставят один раз на
// всю ОС, а не ради конкретного отчёта.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildAnimationPlan,
  renderPlanAt,
  renderPlanFull,
  type AnimationPlan,
} from '@/features/reports-builder/engine/animation';
import { buildReportDocument, type ReportSpec } from '@/features/reports-builder/engine/buildReportText';

export interface Assembly {
  /** Строки отчёта на текущий момент. */
  lines: string[];
  /** Полный текст — активен только после финиша (иначе скопируют недособранное). */
  fullText: string;
  running: boolean;
  done: boolean;
  /** 0..1 — для полоски прогресса. */
  progress: number;
  start: (spec: ReportSpec) => void;
  reset: () => void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReportAssembly(): Assembly {
  const [lines, setLines] = useState<string[]>([]);
  const [fullText, setFullText] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState(0);

  const planRef = useRef<AnimationPlan | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => stopRaf, [stopRaf]);

  const reset = useCallback(() => {
    stopRaf();
    planRef.current = null;
    setLines([]);
    setFullText('');
    setRunning(false);
    setDone(false);
    setProgress(0);
  }, [stopRaf]);

  const start = useCallback((spec: ReportSpec) => {
    stopRaf();
    const plan = buildAnimationPlan(buildReportDocument(spec));
    planRef.current = plan;
    const full = renderPlanFull(plan);
    setFullText(full);

    if (prefersReducedMotion() || plan.totalMs <= 0) {
      setLines(full.split('\n'));
      setRunning(false);
      setDone(true);
      setProgress(1);
      return;
    }

    setRunning(true);
    setDone(false);
    setProgress(0);
    setLines([]);
    startedAtRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startedAtRef.current;
      setLines(renderPlanAt(plan, elapsed));
      setProgress(Math.min(1, elapsed / plan.totalMs));
      if (elapsed >= plan.totalMs) {
        // Финальный кадр берём из плана целиком: доводить «почти собранный»
        // текст руками — верный способ получить расхождение с копируемым.
        setLines(full.split('\n'));
        setProgress(1);
        setRunning(false);
        setDone(true);
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopRaf]);

  return { lines, fullText, running, done, progress, start, reset };
}
