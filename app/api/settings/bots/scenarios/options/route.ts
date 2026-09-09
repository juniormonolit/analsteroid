import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { loadMetrics } from '@/lib/metrics/catalog';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/jobs/scenarioFlow';
import { fetchActiveManagers } from '@/lib/jobs/managerDigest';

// Справочники для редактора сценария: показатели каталога (активные числовые, с
// человеческим описанием и формулой), плейсхолдеры для текстов и список активных
// менеджеров (для аудитории «выбранные»).
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const [metrics, managers] = await Promise.all([loadMetrics(), fetchActiveManagers().catch(() => [])]);
  return NextResponse.json({
    managers: managers.map(m => ({ bitrixId: m.bitrixId, name: m.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    metrics: metrics
      .filter(m => m.isActive && !m.isHiddenInUi && !m.isTest && m.metricType !== 'external')
      .map(m => ({
        id: m.id, name: m.nameRu, short: m.nameShortRu, category: m.category, dataType: m.dataType,
        decimalPlaces: m.decimalPlaces, description: m.humanDescription ?? m.description ?? null, formula: m.formulaHuman ?? null,
      })),
    placeholders: TEMPLATE_PLACEHOLDERS,
  });
}
