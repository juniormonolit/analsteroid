import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { resolveMatrixRequest } from './productMatrixRequest';
import { validateDealFilters, type DealFilter } from '@/lib/metrics/dealFilters';
import type { CreatedTimeFilter, FirstTouchFilter, ProductGroupMode } from '@/lib/metrics/types';
import type { ClientTailOptions } from './clientTail';

// Разбор тела запроса «Вход и хвост» + права — общий для сводки и дрилла
// (/api/reports/client-tail и .../drill): один набор проверок, чтобы дрилл не
// показал сделки шире, чем срез, по которому считана цифра.
// Вход — всегда первичные отгрузки (движок), dealScope тела игнорируется. Период,
// отделы, менеджер, ЧЛ/ЮЛ и срез сессии разбирает общий resolveMatrixRequest (те же
// правила прав, что у матриц); остальные фильтры отчёта — здесь.
export async function resolveClientTailRequest(session: SessionUser, body: Record<string, unknown>):
  Promise<{ ok: true; opts: ClientTailOptions } | { ok: false; error: string; status: number }> {
  if (!hasFullManagerAccess(session) && !hasPerm(session, 'section.client_tail')) {
    return { ok: false, error: 'Нет доступа к разделу «Вход и хвост»', status: 403 };
  }
  const parsed = await resolveMatrixRequest(session, body);
  if (!parsed.ok) return parsed;

  const dfError = validateDealFilters(body.dealFilters);
  if (dfError) return { ok: false, error: dfError, status: 400 };

  const productGroupMode: ProductGroupMode = body.productGroupMode === 'kc' ? 'kc' : 'by_max';
  const productGroupIds = Array.isArray(body.productGroupIds)
    ? (body.productGroupIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length <= 200).slice(0, 200)
    : [];
  const createdTimeFilter = (['all', 'business_hours', 'weekday_after_hours', 'weekend'] as const)
    .find(v => v === body.createdTimeFilter) ?? 'all' as CreatedTimeFilter;
  const firstTouchFilter = (['all', 'off_hours', 'business_hours'] as const)
    .find(v => v === body.firstTouchFilter) ?? 'all' as FirstTouchFilter;
  const windowMonths = typeof body.windowMonths === 'number' && body.windowMonths > 0 ? body.windowMonths : null;

  const { period, managerIds, departmentIds, clientType } = parsed.opts;
  return {
    ok: true,
    opts: {
      period, managerIds, departmentIds, clientType,
      productGroupMode, productGroupIds, createdTimeFilter, firstTouchFilter,
      dealFilters: (body.dealFilters ?? []) as DealFilter[],
      windowMonths,
    },
  };
}
