// Типы автобрака (миграция 265) — отдельно, чтобы board.ts и autoBrak.ts не импортировали друг друга.
import type { CustomFilters } from './customColumns';

/** Правило колонки: mode 'brak' — фильтр выбирает, кто уходит в брак; 'keep' — кто остаётся (остальные — в брак). */
export interface BrakRuleCore { column: string; mode: 'brak' | 'keep'; filters: CustomFilters }

/** Кандидат на автобрак — то, что нужно для брака, журнала и предпросмотра. */
export interface BrakCandidate {
  clientKey: string; managerId: string; managerName: string | null; name: string | null;
  ltv: number; potential: number | null; dealId: number | null; dealOpen: boolean;
}

/** Итог по колонке: сколько остаётся / уходит, деньги, кандидаты (первые 200 — для предпросмотра). */
export interface BrakPreview {
  column: string; keepN: number; keepLtv: number; brakN: number; brakLtv: number; brakPotential: number;
  candidates: BrakCandidate[];
  /** Скрыто с доски (правило с автоприменением, режим «Показывать автобрак» выключен). */
  hidden: number;
}
