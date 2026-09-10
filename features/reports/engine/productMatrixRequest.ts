import { getSessionScope, scopeDeptIdsBitrix, canSeeManager } from '@/lib/org/sessionScope';
import type { SessionUser } from '@/lib/auth/session';
import type { ProductMatrixOptions, MatrixCategoryMode } from './productMatrix';

// Разбор тела запроса матрицы + срез сессии — общий для /api/reports/product-matrix
// и её дрилла (.../transitions): фильтры одни и те же, дублировать проверки прав
// в двух роутах — верный способ разойтись (аудит доступа 09.09).

export type MatrixRequest =
  | { ok: true; opts: Omit<ProductMatrixOptions, 'period'> & { period: { from: Date; to: Date } } }
  | { ok: false; error: string; status: number };

function isValidPeriodInput(p: unknown): p is { from: string; to: string } {
  if (!p || typeof p !== 'object') return false;
  const from = (p as Record<string, unknown>).from;
  const to = (p as Record<string, unknown>).to;
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  return !Number.isNaN(new Date(from).getTime()) && !Number.isNaN(new Date(to).getTime());
}

export async function resolveMatrixRequest(session: SessionUser, body: Record<string, unknown>): Promise<MatrixRequest> {
  if (!isValidPeriodInput(body.period)) {
    return { ok: false, error: 'period.from и period.to обязательны и должны быть валидными датами', status: 400 };
  }
  const scope = await getSessionScope(session);
  let managerIds = Array.isArray(body.managerIds)
    ? (body.managerIds as unknown[]).filter((v): v is string => typeof v === 'string' && /^\d+$/.test(v)).slice(0, 500)
    : [];
  let departmentIds = Array.isArray(body.departmentIds)
    ? (body.departmentIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length <= 64).slice(0, 200)
    : [];
  if (scope.kind !== 'all') {
    if (managerIds.length) {
      const eff = managerIds.filter(id => canSeeManager(scope, id));
      if (eff.length === 0) return { ok: false, error: 'Эти менеджеры вам недоступны', status: 403 };
      managerIds = eff;
    } else if (scope.kind === 'self') {
      managerIds = [...scope.managerIds];
      if (managerIds.length === 0) return { ok: false, error: 'Аккаунт не привязан к менеджеру Битрикса', status: 403 };
    }
    if (scope.kind === 'depts') {
      const effD = await scopeDeptIdsBitrix(scope, departmentIds.length ? departmentIds : undefined);
      if (effD !== null && effD.length === 0) return { ok: false, error: 'Запрошенные отделы вне вашего доступа', status: 403 };
      departmentIds = effD ?? [];
    }
  }
  const mode: MatrixCategoryMode = body.mode === 'positions' ? 'positions' : 'by_max';
  const dealScope = ['primary', 'repeat', 'all'].includes(body.dealScope as string) ? body.dealScope as ProductMatrixOptions['dealScope'] : 'all';
  const clientType = ['b2c', 'b2b', 'all'].includes(body.clientType as string) ? body.clientType as ProductMatrixOptions['clientType'] : 'all';
  return {
    ok: true,
    opts: {
      period: { from: new Date((body.period as { from: string }).from), to: new Date((body.period as { to: string }).to) },
      managerIds, departmentIds, dealScope, clientType, mode,
    },
  };
}
