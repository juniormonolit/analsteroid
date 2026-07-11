'use client';

import { useEffect, useState } from 'react';
import { BranchFilter, type BranchValue } from './BranchFilter';
import { TodayTile } from './TodayTile';
import { PlanBranchGrid } from './PlanBranchGrid';
import { DailySalesChart } from './DailySalesChart';
import { TopManagersCard } from './TopManagersCard';
import { FunnelCard } from './FunnelCard';
import { fmtUpdatedAt } from './format';

// Дашборд «Сводная» (задача 1704). Порядок блоков — мобильный поток мокапа
// (owners-inbox/monolitika-uiux-audit-screens/summary-dashboard-mobile.png):
// Сегодня → План/факт+Проблемная зона → График 30 дней → Топ-5 → Воронка.
// На десктопе (≥1024px) график и топ-5 встают бок о бок (2 колонки), остальное —
// во всю ширину секции — как на summary-dashboard-desktop.png. Колонка страницы —
// --summary-col (app/globals.css, аудит широких экранов), а не старый --content-col
// (тот рассчитан на текстовые страницы вроде /profile, тут сетка карточек).
export function SummaryPage() {
  const [branch, setBranch] = useState<BranchValue>('all');
  // Клиентское «Обновлено: HH:MM» в шапке (мокап) — считается ПОСЛЕ маунта, не при
  // рендере: new Date() прямо в JSX дал бы расхождение SSR/CSR (hydration mismatch),
  // т.к. серверный и клиентский рендер этого client-компонента снимут разное «сейчас».
  const [nowLabel, setNowLabel] = useState<string | null>(null);
  useEffect(() => { setNowLabel(fmtUpdatedAt(new Date().toISOString())); }, []);

  return (
    <div className="flex flex-col h-full overflow-auto bg-[var(--color-bg)]">
      <div className="px-4 py-3 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex items-baseline justify-between gap-3 sticky top-0 z-10">
        <h1 className="text-sm font-semibold text-[var(--color-text)]">Сводная</h1>
        <span className="text-xs text-[var(--color-text-muted)]">{nowLabel && `Обновлено: ${nowLabel}`}</span>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-4 mx-auto w-full" style={{ maxWidth: 'var(--summary-col)' }}>
        <BranchFilter value={branch} onChange={setBranch} />

        <TodayTile branch={branch} />

        <PlanBranchGrid branch={branch} />

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <DailySalesChart branch={branch} />
          <TopManagersCard branch={branch} />
        </div>

        <FunnelCard branch={branch} />
      </div>
    </div>
  );
}
