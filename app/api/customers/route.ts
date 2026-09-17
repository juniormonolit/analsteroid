import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import {
  fetchManagerCustomers, fetchCustomerMarks, classifyWithMark, todayYmdMsk,
  fetchCategorySettings, classifyCategory,
  GLOBAL_REPEAT_CYCLE_DAYS, ACTIVE_NO_CALL_DAYS, AT_RISK_CYCLE_MULTIPLIER,
  SLEEP_CYCLE_MULTIPLIER, SLEEP_MIN_DAYS,
  type CustomerRow, type CustomerMark, type CustomerBucket, type NoCallReason,
  type CustomerCategory, type CustomerModifier,
  assignQueue, QUEUE_ORDER, REPEAT_WINDOW_DAYS, type QueueInfo,
} from '@/features/customers/engine/customers';
import { fetchLastContacts, fetchPendingExclusions, type CustomerContact, type ExclusionRequest } from '@/features/customers/engine/contacts';
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
//
// Продолжение 01.08: отметки клиентов (customer_marks, миграция 123) + авто-архив:
//   * снуз («Отложить») — клиент остаётся в основном виде, но сигналы и «под
//     угрозой» погашены до даты; после даты возвращается сам;
//   * «Больше не звонить» (причина обязательна) — вкладка filter='refused',
//     из сигналов исключён насовсем, mini-аналитика причин в counts;
//   * авто-архив «Спящие» (молчание > max(3×цикла, 120 дн) без активных) —
//     вкладка filter='sleeping'; отметка wake возвращает в основной вид.
// Очереди по окну повторной продажи (задача владельца 17.09): window — окно
// открыто (≤ 22 дн. после отгрузки, контакта нет), missed — окно упущено,
// faded — постоянник затих. 'overdue' оставлен для старых деп-линков = все три.
export type CustomerFilter = 'all' | 'active' | 'inactive' | 'overdue' | 'window' | 'missed' | 'faded' | 'rest' | 'never' | 'sleeping' | 'refused';
const FILTER_KEYS = ['all', 'active', 'inactive', 'overdue', 'window', 'missed', 'faded', 'rest', 'never', 'sleeping', 'refused'] as const;
const PAGE_SIZE_MAX = 100;

/** Строка после применения отметок: сигналы снузнутых погашены, bucket/mark в ответе. */
type XRow = CustomerRow & {
  bucket: CustomerBucket;
  snoozedActive: boolean;
  mark: CustomerMark | null;
  category: CustomerCategory;
  modifiers: CustomerModifier[];
  queue: QueueInfo;
  lastContact: CustomerContact | null;
  pendingExclusion: Pick<ExclusionRequest, 'id' | 'reason' | 'requestedBy' | 'createdAt'> | null;
};

// Сортировка по заголовкам (правило владельца 01.08 «Заголовки = сортировка», по
// образцу /rating 79daf81): цикл убывание → возрастание → дефолт (urgency).
// Пагинация серверная, поэтому и сортировка серверная — клиент сортировал бы
// только видимую страницу. Пустые значения всегда внизу; тай-брейк — дефолтный
// порядок (сигнальный urgency). Имя не сортируется: полных имён на сервере нет
// (ленивый кэш), сортировка по «известным» была бы враньём.
type SortDir = 'desc' | 'asc';
const CATEGORY_RANK: Record<CustomerCategory, number> = { key: 5, large: 4, regular: 3, once: 2, potential: 1, none: 0 };
const SORTS: Record<string, (r: CustomerRow & { category?: CustomerCategory }) => number | string | null> = {
  category: r => CATEGORY_RANK[r.category ?? 'none'],
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
function sectionRank(r: XRow): number {
  // Первичный порядок — очередь по окну повторной продажи (17.09); внутри
  // очереди — её собственный порядок (сгорает первым / деньги), не секции.
  return QUEUE_ORDER.indexOf(r.queue.queue);
}

function applySort(rows: XRow[], key: string | null, dir: SortDir): XRow[] {
  const get = key ? SORTS[key] : undefined;
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const sr = sectionRank(a.r) - sectionRank(b.r);
      if (sr !== 0) return sr;                       // секции не перемешиваются
      if (!get) {
        // Дефолт: порядок очереди (окно — кто сгорает первым, дальше — деньги),
        // отложенные — вниз, тай-брейк — порядок движка.
        if (a.r.snoozedActive !== b.r.snoozedActive) return a.r.snoozedActive ? 1 : -1;
        if (a.r.queue.rank !== b.r.queue.rank) return a.r.queue.rank - b.r.queue.rank;
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

function applyFilter(rows: XRow[], filter: CustomerFilter): XRow[] {
  // Отдельные вкладки: «Отказались» (отметка no_call), «Спящие» (авто-архив),
  // «Ещё не купили». Из всех остальных представлений эти клиенты исключены.
  if (filter === 'refused') return rows.filter(r => r.bucket === 'refused');
  if (filter === 'sleeping') return rows.filter(r => r.bucket === 'sleeping');
  const main = rows.filter(r => r.bucket === 'main');
  if (filter === 'never') return main.filter(r => r.section === 'never');
  const bought = main.filter(r => r.section !== 'never');
  switch (filter) {
    case 'active': return bought.filter(r => r.activeCount > 0);
    case 'inactive': return bought.filter(r => r.activeCount === 0);
    case 'window': return bought.filter(r => r.queue.queue === 'window');
    case 'missed': return bought.filter(r => r.queue.queue === 'missed');
    case 'faded': return bought.filter(r => r.queue.queue === 'faded');
    case 'rest': return bought.filter(r => r.queue.queue === 'rest');
    case 'overdue': return bought.filter(r => r.queue.queue !== 'rest');
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
        sleeping: 0, refused: 0, refusedByReason: {},
        queues: { window: 0, missed: 0, faded: 0, rest: 0, autoLostNoCall: 0 },
      },
      page: 1, pageSize: 50, rows: [],
      thresholds: {
        globalCycleDays: GLOBAL_REPEAT_CYCLE_DAYS, activeNoCallDays: ACTIVE_NO_CALL_DAYS,
        atRiskCycleMultiplier: AT_RISK_CYCLE_MULTIPLIER,
        sleepCycleMultiplier: SLEEP_CYCLE_MULTIPLIER, sleepMinDays: SLEEP_MIN_DAYS,
        windowDays: REPEAT_WINDOW_DAYS,
      },
    });
  }
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const filter = FILTER_KEYS.find(f => f === sp.get('filter')) ?? 'all';
  const search = (sp.get('search') ?? '').trim().toLowerCase();
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(10, Number(sp.get('pageSize')) || 50));
  // Деп-линк по clientKey (задача 2822 — кликабельные имена в дайджесте):
  // открыть КОНКРЕТНОГО заказчика по ключу, независимо от текущего фильтра/
  // страницы/сортировки — ищем в ПОЛНОМ (некэшированном постранично) списке
  // движка, не в urlSearchParams фильтров вкладки. Отдельная, более лёгкая
  // ветка ответа — без счётчиков вкладок, они тут не нужны.
  const keyParam = sp.get('key');

  const engineRows = await fetchManagerCustomers(Number(bitrixId));

  // Отметки — свежим запросом поверх кэша движка (снуз/«не звонить» действуют
  // сразу). У снузнутых сигналы/«под угрозой» гасятся здесь же.
  const keys = engineRows.map(r => r.clientKey);
  const [marks, catSettings, contacts, pending] = await Promise.all([
    fetchCustomerMarks(keys),
    fetchCategorySettings(),
    fetchLastContacts(keys),
    fetchPendingExclusions(keys),
  ]);
  const today = todayYmdMsk();
  const now = Date.now();
  const all: XRow[] = engineRows.map(r => {
    const mark = marks.get(r.clientKey) ?? null;
    const { bucket, snoozedActive } = classifyWithMark(r, mark ?? undefined, today);
    const base = snoozedActive ? { ...r, signals: [], atRisk: false, urgency: 0 } : r;
    // Категория — на лету поверх кэша (дополнение 01.08): правка порогов в
    // настройках действует сразу, без инвалидации 10-минутного кэша движка.
    const { category, modifiers } = classifyCategory(r, catSettings);
    const lastContact = contacts.get(r.clientKey) ?? null;
    // Очередь (17.09) — поверх кэша: ручная отметка «Связался» действует сразу;
    // отложенные — в «остальное».
    const q = assignQueue(r, lastContact?.contactedAt ?? null, now);
    const queue: QueueInfo = snoozedActive ? { ...q, queue: 'rest' } : q;
    const pe = pending.get(r.clientKey);
    return {
      ...base, bucket, snoozedActive, mark, category, modifiers, queue, lastContact,
      pendingExclusion: pe ? { id: pe.id, reason: pe.reason, requestedBy: pe.requestedBy, createdAt: pe.createdAt } : null,
    };
  });

  // Деп-линк по ключу (задача 2822) — короткий путь, отдельный от обычной
  // постраничной выдачи ниже. Ищем БЕЗ учёта filter/category/bucket (снузнутый/
  // спящий/отказавшийся заказчик — деп-линк всё равно должен открыться, это
  // явный переход по ссылке, а не листание вкладки).
  if (keyParam) {
    const found = all.find(r => r.clientKey === keyParam);
    if (!found) return NextResponse.json({ row: null });
    const [names, matrix, csBadges] = await Promise.all([
      resolveClientNames([found.clientKey]),
      fetchCrossSellMatrix(),
      fetchCrossSellBadges(),
    ]);
    const rec = recommendFor(matrix, found.lastGroups);
    if (rec) rec.items = rec.items.map(it => ({ ...it, badge: badgeForPair(csBadges, rec.basedOn, it.group) }));
    return NextResponse.json({ row: { ...found, name: names.get(found.clientKey) ?? null, recommend: rec } });
  }

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
  // Фильтр по категории (дополнение 01.08) — поверх обычного фильтра вкладки.
  const catParam = sp.get('category');
  const catFiltered = catParam && catParam !== 'all'
    ? searched.filter(r => r.category === catParam)
    : searched;
  const filtered = applySort(applyFilter(catFiltered, filter), sortKey, sortDir);
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

  // Счётчики фильтров — по основному виду (купившие, без спящих/отказавшихся);
  // отдельные счётчики вкладок «Спящие»/«Отказались»/«Ещё не купили» + разбивка
  // причин отказа (mini-аналитика вкладки «Отказались»).
  const main = searched.filter(r => r.bucket === 'main');
  const bought = main.filter(r => r.section !== 'never');
  const refused = searched.filter(r => r.bucket === 'refused');
  const refusedByReason: Record<string, number> = {};
  for (const r of refused) {
    const reason: NoCallReason = r.mark?.reason ?? 'other';
    refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1;
  }
  return NextResponse.json({
    total: filtered.length,
    counts: {
      all: bought.length,
      active: bought.filter(r => r.activeCount > 0).length,
      inactive: bought.filter(r => r.activeCount === 0).length,
      overdue: bought.filter(r => r.queue.queue !== 'rest').length,
      refusedNoCall: searched.filter(r => r.refusedNoCall).length,
      queues: {
        window: bought.filter(r => r.queue.queue === 'window').length,
        missed: bought.filter(r => r.queue.queue === 'missed').length,
        faded: bought.filter(r => r.queue.queue === 'faded').length,
        rest: bought.filter(r => r.queue.queue === 'rest').length,
        autoLostNoCall: bought.filter(r => r.autoRepeatLostNoCall && r.queue.queue !== 'rest').length,
      },
      sections: {
        regular: bought.filter(r => r.section === 'regular').length,
        regularAtRisk: bought.filter(r => r.atRisk).length,
        once: bought.filter(r => r.section === 'once').length,
        never: main.filter(r => r.section === 'never').length,
      },
      sleeping: searched.filter(r => r.bucket === 'sleeping').length,
      refused: refused.length,
      refusedByReason,
      // Категории (дополнение 01.08): счётчики по основному виду + ключевые под угрозой.
      byCategory: {
        key: main.filter(r => r.category === 'key').length,
        large: main.filter(r => r.category === 'large').length,
        regular: main.filter(r => r.category === 'regular').length,
        once: main.filter(r => r.category === 'once').length,
        potential: main.filter(r => r.category === 'potential').length,
        keyAtRisk: main.filter(r => r.category === 'key' && r.atRisk).length,
      },
    },
    page, pageSize, rows,
    thresholds: {
      globalCycleDays: GLOBAL_REPEAT_CYCLE_DAYS, activeNoCallDays: ACTIVE_NO_CALL_DAYS,
      atRiskCycleMultiplier: AT_RISK_CYCLE_MULTIPLIER,
      sleepCycleMultiplier: SLEEP_CYCLE_MULTIPLIER, sleepMinDays: SLEEP_MIN_DAYS,
      windowDays: REPEAT_WINDOW_DAYS,
    },
  });
}
