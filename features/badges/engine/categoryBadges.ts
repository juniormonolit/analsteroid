// Награды за категории клиентов (три штуки, ок Серёги 01.08, пакет категорий):
//   «Кит-мейкер» (category_keymaker, 150, редкая) — клиент ВПЕРВЫЕ стал
//     «Ключевым» (кумулятивные отгрузки достигли обоих порогов) сделкой этого
//     менеджера; награда — менеджеру сделки, пробившей порог.
//   «Апгрейд» (category_upgrade, 40) — клиент впервые достиг «Крупного»
//     (сумма ИЛИ количество отгрузок) сделкой менеджера.
//   «Хранитель ключей» (category_keykeeper, 60, ежемесячная) — за календарный
//     месяц ни один ключевой клиент менеджера не был «под угрозой» (и ключевые
//     вообще были). Ретро-версия «под угрозой в месяце M»: у клиента была
//     тишина между продажами (или открытый хвост) > 2× его цикла повторки,
//     пересёкшая месяц M; условие «нет активных сделок» в ретро не
//     восстановить (истории стадий по дням нет) — осознанное упрощение,
//     живой сигнал «под угрозой» в списке заказчиков остаётся точным.
//
// Начисление — в общем ночном пересчёте (runBadgeRecompute), идемпотентно:
// «первое достижение категории клиентом = одна награда» гарантируется ключом
// badge_awards (bitrix, badge, period_type='day', period_date=дата пробития);
// два разных клиента одного менеджера в ОДИН день сливаются в одну строку с
// value=N (плата за строку одна — редкая коллизия, отмечена в отчёте задачи).
// Пороги — из customer_category_settings (та же таблица, что список).
//
// Клиентская сегментация — как в «Моих заказчиках» (funnel 0/2 → contact,
// 1/3 → company, воронки 4/7 исключены).
//
// Задача 2776 (фикс химеры «k0», owners-inbox/customers-k0-merge-issue.md):
// формула ключа теперь ЕДИНАЯ с общим движком (features/customers/engine/
// clientKey.ts) — company_id=0 больше НЕ склеивается в один 'k0' с суммой
// всей истории компании, а разъезжается по contact_id (префикс 'x'). Это
// ОЖИДАЕМО меняет начисления: реальные клиенты, ранее скрытые внутри «k0»,
// теперь могут ВПЕРВЫЕ легитимно пересечь пороги «Ключевой»/«Крупный» и
// получить «Кит-мейкер»/«Апгрейд» — не баг, а снятие маскировки (см. отчёт,
// раздел 5, «Общее для обоих вариантов»).
// Собственная, более старая защита ЭТОГО файла — исключение 'c0' (contact_id=0
// у физлиц, зеркальная и более мелкая версия «k0», отчёт п.1.3) — оставлена
// как была: общий движок её сознательно не гасит (вне скоупа фикса).
import { analyticsDb } from '@/lib/db/clients';
import {
  fetchCategorySettings, GLOBAL_REPEAT_CYCLE_DAYS, MIN_CYCLE_DAYS,
  AT_RISK_CYCLE_MULTIPLIER,
} from '@/features/customers/engine/customers';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import type { BadgeTier } from './catalog';

export interface CategoryAwardRow {
  bitrixId: number;
  badgeKey: string;
  tier: BadgeTier | null;
  periodType: 'day' | 'week' | 'month' | 'year' | null;
  periodDate: string | null;
  value: number | null;
  counter?: boolean;
}

interface DealRow {
  client_key: string;
  deal_id: number;
  created_at: string | Date;
  sold_at: string | Date | null;
  delivered_at: string | Date | null;
  amount: string | null;
  current_manager_id: number | null;
}

const DAY_MS = 86_400_000;
// Порог релевантной выборки для «Хранителя ключей» (решение владельца 05.08):
// удержание ОДНОГО ключевого клиента — не портфель.
const MIN_KEY_CLIENTS_FOR_KEEPER = 3;
const ymd = (v: string | Date) => (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);
const ts = (v: string | Date) => (v instanceof Date ? v : new Date(v)).getTime();

export async function computeCategoryBadgeAwards(todayYmd: string): Promise<CategoryAwardRow[]> {
  const s = await fetchCategorySettings();

  // Только клиенты, вообще дотягивающие до «Крупного»/«Ключевого» — их сотни,
  // полная история сделок таких клиентов легко помещается в память.
  const res = await analyticsDb().query<DealRow>(`
    WITH cd AS (
      SELECT * FROM (
        SELECT (${CLIENT_KEY_CASE_SQL}) AS client_key,
               d.deal_id, d.created_at, d.sold_at, d.delivered_at, d.amount, d.current_manager_id
        FROM sa.deals d
        WHERE d.funnel_id IN (0,1,2,3)
      ) t
      -- client_key IS NULL — уже гасит company_id IS NULL и «0,3% без contact_id»
      -- (см. CLIENT_KEY_CASE_SQL). 'c0' — своя, более старая защита этого файла
      -- (contact_id=0 у физлиц, отчёт п.1.3) — общая формула её не покрывает.
      WHERE client_key IS NOT NULL AND client_key <> 'c0'
    ),
    big AS (
      SELECT client_key
      FROM cd WHERE delivered_at IS NOT NULL
      GROUP BY 1
      HAVING COALESCE(sum(amount), 0) >= LEAST($1::numeric, $2::numeric)
          OR count(*) >= LEAST($3::int, $4::int)
    )
    SELECT cd.* FROM cd JOIN big USING (client_key)
    ORDER BY client_key, delivered_at NULLS LAST, deal_id
  `, [s.largeMinSum, s.keyMinSum, s.largeMinShipments, s.keyMinShipments]);

  // Группировка по клиенту
  const byClient = new Map<string, DealRow[]>();
  for (const r of res.rows) {
    const arr = byClient.get(r.client_key) ?? [];
    arr.push(r);
    byClient.set(r.client_key, arr);
  }

  const awards: CategoryAwardRow[] = [];
  // (manager, badge, day) → value (коллизии «два клиента в один день» → value=N)
  const dayAward = new Map<string, { bitrixId: number; badgeKey: string; day: string; value: number }>();
  const addDayAward = (mgr: number | null, badgeKey: string, day: string) => {
    if (mgr === null) return;
    const k = `${mgr}:${badgeKey}:${day}`;
    const cur = dayAward.get(k);
    if (cur) cur.value += 1;
    else dayAward.set(k, { bitrixId: mgr, badgeKey, day, value: 1 });
  };

  // Ключевые клиенты для «Хранителя ключей»: firstKeyYmd + продажные даты + менеджер as-of.
  const keyClients: { clientKey: string; firstKeyYmd: string; soldTs: number[]; deals: DealRow[] }[] = [];

  for (const [clientKey, deals] of byClient) {
    let cnt = 0; let sum = 0;
    let largeAt: DealRow | null = null;
    let keyAt: DealRow | null = null;
    for (const d of deals) {
      if (d.delivered_at === null) continue;
      cnt += 1; sum += Number(d.amount ?? 0);
      if (!largeAt && (sum >= s.largeMinSum || cnt >= s.largeMinShipments)) largeAt = d;
      if (!keyAt && cnt >= s.keyMinShipments && sum >= s.keyMinSum) keyAt = d;
    }
    if (largeAt && largeAt.delivered_at) addDayAward(largeAt.current_manager_id, 'category_upgrade', ymd(largeAt.delivered_at));
    if (keyAt && keyAt.delivered_at) {
      addDayAward(keyAt.current_manager_id, 'category_keymaker', ymd(keyAt.delivered_at));
      keyClients.push({
        clientKey,
        firstKeyYmd: ymd(keyAt.delivered_at),
        soldTs: deals.filter(d => d.sold_at !== null).map(d => ts(d.sold_at!)).sort((a, b) => a - b),
        deals,
      });
    }
  }
  for (const a of dayAward.values()) {
    awards.push({ bitrixId: a.bitrixId, badgeKey: a.badgeKey, tier: null, periodType: 'day', periodDate: a.day, value: a.value });
  }

  // ── «Хранитель ключей»: закрытые месяцы, по ключевым клиентам менеджера ────
  if (keyClients.length > 0) {
    // цикл клиента — как в списке: медиана интервалов >=1 дня (>=3 покупок), иначе базовый
    const cycleOf = (soldTs: number[]): number => {
      const gaps: number[] = [];
      for (let i = 1; i < soldTs.length; i++) {
        const g = (soldTs[i] - soldTs[i - 1]) / DAY_MS;
        if (g >= 1) gaps.push(g);
      }
      let cycle = GLOBAL_REPEAT_CYCLE_DAYS;
      if (gaps.length >= 2 && soldTs.length >= 3) {
        gaps.sort((a, b) => a - b);
        const mid = Math.floor(gaps.length / 2);
        cycle = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
      }
      return Math.max(cycle, MIN_CYCLE_DAYS);
    };
    // атрибуция as-of конца месяца: менеджер последней созданной сделки клиента к этой дате
    const managerAsOf = (deals: DealRow[], endTs: number): number | null => {
      let best: DealRow | null = null;
      for (const d of deals) {
        if (ts(d.created_at) > endTs || d.current_manager_id === null) continue;
        if (!best || ts(d.created_at) > ts(best.created_at)
          || (ts(d.created_at) === ts(best.created_at) && d.deal_id > best.deal_id)) best = d;
      }
      return best?.current_manager_id ?? null;
    };
    // «под угрозой в месяце M»: тишина между продажами (или открытый хвост до
    // endM) > AT_RISK_CYCLE_MULTIPLIER × цикла, пересёкшая интервал месяца.
    const atRiskInMonth = (soldTs: number[], cycle: number, startTs: number, endTs: number): boolean => {
      const limit = AT_RISK_CYCLE_MULTIPLIER * cycle * DAY_MS;
      const before = soldTs.filter(t => t <= endTs);
      if (before.length === 0) return false;
      for (let i = 0; i < before.length; i++) {
        const from = before[i];
        const to = i + 1 < before.length ? before[i + 1] : endTs;
        const capped = Math.min(to, endTs);
        if (capped <= startTs && capped !== endTs) continue; // тишина закончилась до M
        if (capped - from > limit && capped >= startTs) return true;
      }
      return false;
    };

    const firstMonth = keyClients.reduce((m, c) => (c.firstKeyYmd < m ? c.firstKeyYmd : m), todayYmd).slice(0, 7);
    const thisMonth = todayYmd.slice(0, 7);
    // (manager, month) → { hasKey, violated }
    const byMgrMonth = new Map<string, { bitrixId: number; month: string; violated: boolean; keys: Set<string> }>();
    for (let m = firstMonth; m < thisMonth; m = nextMonth(m)) {
      const startTs = new Date(`${m}-01T00:00:00+03:00`).getTime();
      const endTs = new Date(`${nextMonth(m)}-01T00:00:00+03:00`).getTime() - 1;
      for (const c of keyClients) {
        if (c.firstKeyYmd.slice(0, 7) > m) continue; // ещё не был ключевым
        const mgr = managerAsOf(c.deals, endTs);
        if (mgr === null) continue;
        const k = `${mgr}:${m}`;
        const entry = byMgrMonth.get(k) ?? { bitrixId: mgr, month: m, violated: false, keys: new Set<string>() };
        entry.keys.add(c.clientKey);
        if (atRiskInMonth(c.soldTs, cycleOf(c.soldTs), startTs, endTs)) entry.violated = true;
        byMgrMonth.set(k, entry);
      }
    }
    for (const e of byMgrMonth.values()) {
      if (e.violated) continue;
      // Правило релевантной выборки (05.08): «удержал ВСЕХ ключевых» при одном
      // ключевом клиенте — не заслуга «хранителя». Требуем портфель.
      if (e.keys.size < MIN_KEY_CLIENTS_FOR_KEEPER) continue;
      awards.push({
        bitrixId: e.bitrixId, badgeKey: 'category_keykeeper', tier: null,
        periodType: 'month', periodDate: `${e.month}-01`, value: null,
      });
    }
  }

  return awards;
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
