import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { loadMetrics } from '@/lib/metrics/catalog';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/jobs/scenarios';

// Справочники для формы сценария: показатели каталога (все активные числовые, с
// человеческим описанием — чтобы в пикере было понятно, что берёшь) и список
// плейсхолдеров для текстов. Поиск — на клиенте.
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const metrics = await loadMetrics();
  return NextResponse.json({
    metrics: metrics
      .filter(m => m.isActive && !m.isHiddenInUi && !m.isTest && m.metricType !== 'external')
      .map(m => ({
        id: m.id, name: m.nameRu, short: m.nameShortRu, category: m.category, dataType: m.dataType,
        decimalPlaces: m.decimalPlaces, description: m.humanDescription ?? m.description ?? null,
        formula: m.formulaHuman ?? null,
      })),
    placeholders: TEMPLATE_PLACEHOLDERS,
  });
}
