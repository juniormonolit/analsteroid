import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchManagerCustomers, GLOBAL_REPEAT_CYCLE_DAYS, ACTIVE_NO_CALL_DAYS, type CustomerRow } from '@/features/customers/engine/customers';
import { getCachedClientNames, resolveClientNames } from '@/lib/bitrix/clientNames';
import { fetchCrossSellMatrix, recommendFor } from '@/features/customers/engine/crossSell';

// «Мои заказчики» (фича Серёги 01.08): постраничный список клиентов менеджера.
// Доступ — тот же рубеж canViewManager, что у всей карточки (менеджер — себя,
// РОП — своих подчинённых, руководство — всех; чужим — 403).
//
// Тяжёлый агрегат целиком живёт в Redis-кэше движка (10 мин); фильтры, поиск и
// пагинация режутся поверх кэша здесь. Имена клиентов: для ПОИСКА — только из
// кэша имён (в sa-БД имён нет; пока имя не закэшировано, клиент ищется по id),
// для СТРАНИЦЫ — ленивый добор из Битрикса (lib/bitrix/clientNames.ts).
// ПДн: телефоны не запрашиваются и в ответе отсутствуют by construction.

export type CustomerFilter = 'all' | 'active' | 'inactive' | 'overdue';
const PAGE_SIZE_MAX = 100;

function applyFilter(rows: CustomerRow[], filter: CustomerFilter): CustomerRow[] {
  switch (filter) {
    case 'active': return rows.filter(r => r.activeCount > 0);
    case 'inactive': return rows.filter(r => r.activeCount === 0);
    case 'overdue': return rows.filter(r => r.signals.length > 0);
    default: return rows;
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const requested = sp.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!bitrixId) {
    return NextResponse.json({
      total: 0, counts: { all: 0, active: 0, inactive: 0, overdue: 0, refusedNoCall: 0 },
      page: 1, pageSize: 50, rows: [], thresholds: { globalCycleDays: GLOBAL_REPEAT_CYCLE_DAYS, activeNoCallDays: ACTIVE_NO_CALL_DAYS },
    });
  }
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const filter = (['all', 'active', 'inactive', 'overdue'] as const).find(f => f === sp.get('filter')) ?? 'all';
  const search = (sp.get('search') ?? '').trim().toLowerCase();
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(10, Number(sp.get('pageSize')) || 50));

  const all = await fetchManagerCustomers(Number(bitrixId));

  // Поиск по имени — по уже известным (закэшированным) именам + по id клиента.
  let searched = all;
  if (search) {
    const names = await getCachedClientNames(all.map(r => r.clientKey));
    searched = all.filter(r => {
      const name = names.get(r.clientKey);
      return (name && name.toLowerCase().includes(search)) || String(r.clientId).includes(search);
    });
  }

  const filtered = applyFilter(searched, filter);
  const start = (page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  // Имена — только для видимой страницы (ленивый добор из Битрикса + кэш);
  // кросс-селл рекомендация «что предложить» — из матрицы переходов (Redis 24ч).
  const [names, matrix] = await Promise.all([
    resolveClientNames(pageRows.map(r => r.clientKey)),
    fetchCrossSellMatrix(),
  ]);
  const rows = pageRows.map(r => ({
    ...r,
    name: names.get(r.clientKey) ?? null,
    recommend: recommendFor(matrix, r.lastGroups),
  }));

  return NextResponse.json({
    total: filtered.length,
    counts: {
      all: searched.length,
      active: searched.filter(r => r.activeCount > 0).length,
      inactive: searched.filter(r => r.activeCount === 0).length,
      overdue: searched.filter(r => r.signals.length > 0).length,
      refusedNoCall: searched.filter(r => r.refusedNoCall).length,
    },
    page, pageSize, rows,
    thresholds: { globalCycleDays: GLOBAL_REPEAT_CYCLE_DAYS, activeNoCallDays: ACTIVE_NO_CALL_DAYS },
  });
}
