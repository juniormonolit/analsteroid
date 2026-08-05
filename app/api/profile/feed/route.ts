import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadXpSettings, levelFromXp, titleForLevel } from '@/features/xp/engine/xp';

// Лента событий профиля (задача владельца 05.08, этап 2 ЛК-соцсетки: «пусть в
// профиле будет лента отдельными постами-событиями — получена награда, сделана
// крупная продажа, выполнен квест — чтоб профиль был живым»).
//
// Ленты как ХРАНИМОЙ сущности нет — события собираются на лету UNION'ом из трёх
// живых источников (badge_awards / quests(done) / sa.deals), ничего не пишем и
// не бэкфиллим. Доступ — любой залогиненный: лента часть публичного профиля
// (то же решение владельца, что и для /api/badges/profile).

const LIMIT = 30;                    // событий в ответе
const PER_SOURCE = 30;               // с каждого источника до слияния
const BIG_SALE_THRESHOLD = 1_000_000; // ₽; «крупная продажа» по владельцу — порог в коде

export interface FeedEvent {
  type: 'badge' | 'quest' | 'sale' | 'level' | 'first_sale';
  ts: string;
  title: string;
  emoji: string;
  /** badge: bronze|silver|gold|platinum; quest: white|green|blue|epic|legendary */
  tier: string | null;
  amount: number | null;   // sale: сумма сделки
  subtitle: string | null; // sale: головная группа; quest: награда; first_sale: сделка
}

// «Новый уровень» (доп. владельца 05.08): хранимых событий level-up нет —
// восстанавливаем их из XP-леджера. XP приходит из двух источников: сделки
// (xp_ledger, день = sold_day/ship_day) и квесты (reward_xp на done_at) — та же
// пара, что в fetchXpProfile. Идём по дням, копим сумму и ловим моменты, когда
// levelFromXp пересекает очередной порог.
async function levelUpEvents(idNum: number): Promise<FeedEvent[]> {
  try {
    const [settings, ledger, quests] = await Promise.all([
      loadXpSettings(systemDb()),
      systemDb().query<{ day: string; xp: string }>(
        `SELECT COALESCE(sold_day, ship_day)::text AS day, sum(total_xp)::text AS xp
           FROM xp_ledger
          WHERE bitrix_id = $1 AND COALESCE(sold_day, ship_day) IS NOT NULL
          GROUP BY 1`,
        [idNum],
      ),
      systemDb().query<{ day: string; xp: string }>(
        `SELECT done_at::date::text AS day, sum(reward_xp)::text AS xp
           FROM quests
          WHERE bitrix_id = $1 AND status = 'done' AND done_at IS NOT NULL AND reward_xp > 0
          GROUP BY 1`,
        [idNum],
      ),
    ]);
    const byDay = new Map<string, number>();
    for (const r of [...ledger.rows, ...quests.rows]) {
      byDay.set(r.day, (byDay.get(r.day) ?? 0) + Number(r.xp));
    }
    const events: FeedEvent[] = [];
    let cum = 0;
    let level = 0;
    for (const day of [...byDay.keys()].sort()) {
      cum += byDay.get(day)!;
      const next = levelFromXp(cum, settings.levelBase, settings.levelExp);
      if (next > level) {
        // Полдень МСК-дня — детального времени у дневных агрегатов нет, а полночь
        // проигрывала бы сортировку всем событиям того же дня.
        events.push({
          type: 'level', ts: `${day}T09:00:00Z`,
          title: `${next} уровень — ${titleForLevel(next)}`,
          emoji: '🎖️', tier: null, amount: null, subtitle: null,
        });
        level = next;
      }
    }
    return events.slice(-PER_SOURCE);
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bitrixId = req.nextUrl.searchParams.get('bitrixId');
  if (!bitrixId || !/^\d+$/.test(bitrixId)) {
    return NextResponse.json({ error: 'bitrixId (число) обязателен' }, { status: 400 });
  }
  const idNum = Number(bitrixId);

  // Источники независимы; недоступность одного (например, таблиц квестов до
  // миграции) не валит ленту целиком — each ловится отдельно.
  const [badges, quests, sales, levels, firstSales] = await Promise.all([
    // xp_first_group («Первая кровь») исключён: то же событие лента показывает
    // богаче — постом first_sale из сделок (группа + сделка + точная дата),
    // бейдж рядом был бы дублем.
    systemDb().query<{ ts: string; name: string; icon: string; tier: string | null }>(
      `SELECT a.awarded_at AS ts, d.name, d.icon, a.tier
         FROM badge_awards a
         JOIN badge_definitions d ON d.key = a.badge_key
        WHERE a.bitrix_id = $1 AND a.badge_key <> 'xp_first_group'
        ORDER BY a.awarded_at DESC
        LIMIT $2`,
      [idNum, PER_SOURCE],
    ).catch(() => ({ rows: [] as { ts: string; name: string; icon: string; tier: string | null }[] })),
    systemDb().query<{ ts: string; title: string; tier: string; reward_eballs: number; reward_xp: number }>(
      `SELECT done_at AS ts, title, tier, reward_eballs, reward_xp
         FROM quests
        WHERE bitrix_id = $1 AND status = 'done' AND done_at IS NOT NULL
        ORDER BY done_at DESC
        LIMIT $2`,
      [idNum, PER_SOURCE],
    ).catch(() => ({ rows: [] as { ts: string; title: string; tier: string; reward_eballs: number; reward_xp: number }[] })),
    analyticsDb().query<{ ts: string; deal_name: string; amount: string; head_group_name: string | null }>(
      `SELECT sold_at AS ts, deal_name, amount::text, head_group_name
         FROM sa.deals
        WHERE current_manager_id = $1 AND sold_at IS NOT NULL AND amount >= $2
        ORDER BY sold_at DESC
        LIMIT $3`,
      [idNum, BIG_SALE_THRESHOLD, PER_SOURCE],
    ).catch(() => ({ rows: [] as { ts: string; deal_name: string; amount: string; head_group_name: string | null }[] })),
    levelUpEvents(idNum),
    // «Первая продажа в новой группе» (доп. владельца 05.08): первая по времени
    // проданная сделка в каждой головной группе.
    analyticsDb().query<{ ts: string; head_group_name: string; deal_name: string }>(
      `SELECT DISTINCT ON (head_group_name) sold_at AS ts, head_group_name, deal_name
         FROM sa.deals
        WHERE current_manager_id = $1 AND sold_at IS NOT NULL AND head_group_name IS NOT NULL
        ORDER BY head_group_name, sold_at ASC`,
      [idNum],
    ).catch(() => ({ rows: [] as { ts: string; head_group_name: string; deal_name: string }[] })),
  ]);

  const events: FeedEvent[] = [
    ...badges.rows.map((r): FeedEvent => ({
      type: 'badge', ts: r.ts, title: r.name, emoji: r.icon || '🏅', tier: r.tier, amount: null, subtitle: null,
    })),
    ...quests.rows.map((r): FeedEvent => ({
      type: 'quest', ts: r.ts, title: r.title, emoji: '⚔️', tier: r.tier, amount: null,
      subtitle: [r.reward_eballs ? `+${r.reward_eballs} MLT` : null, r.reward_xp ? `+${r.reward_xp} XP` : null].filter(Boolean).join(' · ') || null,
    })),
    ...sales.rows.map((r): FeedEvent => ({
      type: 'sale', ts: r.ts, title: r.deal_name, emoji: '💰', tier: null,
      amount: Math.round(Number(r.amount)), subtitle: r.head_group_name,
    })),
    ...levels,
    ...firstSales.rows.map((r): FeedEvent => ({
      type: 'first_sale', ts: r.ts, title: r.head_group_name, emoji: '🩸', tier: null,
      amount: null, subtitle: r.deal_name,
    })),
  ]
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, LIMIT);

  return NextResponse.json({ events });
}
