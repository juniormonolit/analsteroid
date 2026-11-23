// Задачник: белый список «прокачиваемых» метрик с направлением + флаг «проект в Битриксе настроен».
import { NextResponse } from 'next/server';
import { taskerAuth } from '@/features/tasker/engine/http';
import { errorResponse, loadMetricDefs, loadSettings, publicMetric } from '@/features/tasker/engine/config';
import { getEmployeeDirectory } from '@/lib/org/employeeDirectory';
import type { TaskerMetricsResponse } from '@/features/tasker/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await taskerAuth();
  if (auth instanceof Response) return auth;
  try {
    const [metrics, settings] = await Promise.all([loadMetricDefs(), loadSettings()]);
    const dir = await getEmployeeDirectory().catch(() => null);
    const trainer = { id: Number(settings.trainerId), name: dir?.get(Number(settings.trainerId))?.name ?? `#${settings.trainerId}` };
    const out: TaskerMetricsResponse = { metrics: metrics.map(publicMetric), bitrixConfigured: !!settings.groupId, trainer };
    return NextResponse.json(out);
  } catch (e) {
    return errorResponse(e);
  }
}
