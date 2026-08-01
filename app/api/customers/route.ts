import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchManagerCustomers, GLOBAL_REPEAT_CYCLE_DAYS, ACTIVE_NO_CALL_DAYS, AT_RISK_CYCLE_MULTIPLIER, type CustomerRow } from '@/features/customers/engine/customers';
import { getCachedClientNames, resolveClientNames } from '@/lib/bitrix/clientNames';
import { fetchCrossSellMatrix, recommendFor, fetchCrossSellBadges, badgeForPair } from '@/features/customers/engine/crossSell';

// «Мои заказчики» (фича Серёги 01.08): постраничный список клиентов менеджера.
// Доступ — тот же рубеж canViewManager, что у всей карточки (менеджер — себя,
// РОП — своих подчинённых, руководство — всех; чужим — 403).
//
// Тяжёлый агрегат целиком живёт в Redis-кэше движка (10 мин); фильтры, поиск и
// пагинация режутся поверх кэша здесь. Имена клиентов: для ПОИСКА — только из
// кэша имён (в sa-БД имён нет; пока имя не закэшировано, клиент ищется по id),
// для СТРАНИЦЫ — ленивый добор из Битрикса (lib/bitrix/clientNames.ts).
// ПДн: телефоны не запрашиваются и в ответе отсутствуют by construction.

// Секции (доработка Серёги 01.08): основной вид — «Постоянники» (2+ успешных
// сделок) сверху, затем «Купили один раз»; клиенты БЕЗ покупок из основного
// вида убраны в отдельную вкладку filter='never' (не удалены — там живут
// сигналы по активным сделкам). Сортировка по заголовкам работает ВНУТРИ
// секций (группировка по секции — всегда первичный ключ порядка).
export type CustomerFilter = 'all' | 'active' | 'inactive' | 'overdue' | 'never';
const PAGE_SIZE_MAX = 100;

// Сортировка по заголовкам (правило владельца 01.08 «Заголовки = сортировка», по
// образцу /rating 79daf81): цикл убывание → возрастание → дефолт (urgency).
// Пагинация серверная, поэтому и сортировка серверная — клиент сортировал бы
// только видимую страницу. Пустые значения всегда внизу; тай-брейк — дефолтный
// порядок (сигнальный urgency). Имя не сортируется: полных имён на сервере нет
// (ленивый кэш), сортировка по «известным» была бы враньём.
type SortDir = 'desc' | 'asc';
const SORTS: Record<string, (r: CustomerRow) => number | string | null> = {
  dealsTotal: r => r.dealsTotal,
  dealsSold: r => r.dealsSold,
  sumSold: r => r.sumSold,
  lastSoldAt: r => r.lastSoldAt,
  lastCallAt: r => r.lastCallAt,
  lastActivityAt: r => r.lastActivityAt,
  activeCount: r => r.activeCount,
};

// Первичный порядок секций: постоянники → купили один раз (never в основном
// виде отфильтрован). Внутри секции постоянников «под угрозой» — выше всех
// (доработка 01.08), дальше — дефолтный порядок движка (сигнал/urgency) либо
// выбранная заголовком сортировка.
function sectionRank(r: CustomerRow): number {
  return r.section === 'regular' ? 0 : r.section === 'once' ? 1 : 2;
}

function applySort(rows: CustomerRow[], key: string | null, dir: SortDir): CustomerRow[] {
  const get = key ? SORTS[key] : undefined;
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const sr = sectionRank(a.r) - sectionRank(b.r);
      if (sr !== 0) return sr;                       // секции не перемешиваются
      if (!get) {
        // Дефолт: «под угрозой» выше всех в секции, дальше порядок движка.
        if (a.r.atRisk !== b.r.atRisk) return a.r.atRisk ? -1 : 1;
        return a.i - b.i;
      }
      const va = get(a.r); const vb = get(b.r);
      if (va === null && vb === null) return a.i - b.i;
      if (va === null) return 1;   // пустые всегда внизу (в своей секции)
      if (vb === null) return -1;
      if (va < vb) return -sign;
      if (va > vb) return sign;
      return a.i - b.i;            // тай-брейк — дефолтный порядок
    })
    .map(x => x.r);
}

function applyFilter(rows: CustomerRow[], filter: CustomerFilter): CustomerRow[] {
  // Вкладка «Ещё не купили» — единственное место, где видны клиенты без покупок;
  // из всех остальных представлений они исключены (доработка 01.08).
  if (filter === 'never') return rows.filter(r => r.section === 'never');
  const bought = rows.filter(r => r.section !== 'never');
  switch (filter) {
    case 'active': return bought.filter(r => r.activeCount > 0);
    case 'inactive': return bought.filter(r => r.activeCount === 0);
    case 'overdue': return bought.filter(r => r.signals.length > 0);
    default: return bought;
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
      total: 0,
      counts: {
        all: 0, active: 0, inactive: 0, overdue: 0, refusedNoCall: 0,
        sections: { regular: 0, regularAtRisk: 0, once: 0, never: 0 },
      },
      page: 1, pageSize: 50, rows: [],
      thresholds: { globalCycleDays: GLOBAL_REPEAT_CYCLE_DAYS, activeNoCallDays: ACTIVE_NO_CALL_DAYS, atRiskCycleMultiplier: AT_RISK_CYCLE_MULTIPLIER },
    });
  }
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const filter = (['all', 'active', 'inactive', 'overdue', 'never'] as const).find(f => f === sp.get('filter')) ?? 'all';
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

  const sortKey = sp.get('sort');
  const sortDir: SortDir = sp.get('dir') === 'asc' ? 'asc' : 'desc';
  const filtered = applySort(applyFilter(searched, filter), sortKey, sortDir);
  const start = (page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  // Имена — только для видимой страницы (ленивый добор из Битрикса + кэш);
  // кросс-селл рекомендация «что предложить» — из матрицы переходов (Redis 24ч);
  // к рекомендации — бейдж и ебаллы за допродажу пары (доработка Серёги 01.08).
  const [names, matrix, csBadges] = await Promise.all([
    resolveClientNames(pageRows.map(r => r.clientKey)),
    fetchCrossSellMatrix(),
    fetchCrossSellBadges(),
  ]);
  const rows = pageRows.map(r => {
    const rec = recommendFor(matrix, r.lastGroups);
    if (rec) {
      rec.items = rec.items.map(it => ({ ...it, badge: badgeForPair(csBadges, rec.basedOn, it.group) }));
    }
    return { ...r, name: names.get(r.clientKey) ?? null, recommend: rec };
  });

  // Счётчики фильтров — по купившим (без «ещё не купили»), счётчики секций —
  // по всем строкам поиска (в т.ч. never для его вкладки).
  const bought = searched.filter(r => r.section !== 'never');
  return NextResponse.json({
    total: filtered.length,
    counts: {
      all: bought.length,
      active: bought.filter(r => r.activeCount > 0).length,
      inactive: bought.filter(r => r.activeCount === 0).length,
      overdue: bought.filter(r => r.signals.length > 0).length,
      refusedNoCall: searched.filter(r => r.refusedNoCall).length,
      sections: {
        regular: bought.filter(r => r.section === 'regular').length,
        regularAtRisk: bought.filter(r => r.atRisk).length,
        once: bought.filter(r => r.section === 'once').length,
        never: searched.filter(r => r.section === 'never').length,
      },
    },
    page, pageSize, rows,
    thresholds: { globalCycleDays: GLOBAL_REPEAT_CYCLE_DAYS, activeNoCallDays: ACTIVE_NO_CALL_DAYS, atRiskCycleMultiplier: AT_RISK_CYCLE_MULTIPLIER },
  });
}
