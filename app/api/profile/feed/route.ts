import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';

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
  type: 'badge' | 'quest' | 'sale';
  ts: string;
  title: string;
  emoji: string;
  /** badge: bronze|silver|gold|platinum; quest: white|green|blue|epic|legendary */
  tier: string | null;
  amount: number | null;   // sale: сумма сделки
  subtitle: string | null; // sale: головная группа; quest: награда
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
  const [badges, quests, sales] = await Promise.all([
    systemDb().query<{ ts: string; name: string; icon: string; tier: string | null }>(
      `SELECT a.awarded_at AS ts, d.name, d.icon, a.tier
         FROM badge_awards a
         JOIN badge_definitions d ON d.key = a.badge_key
        WHERE a.bitrix_id = $1
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
  ]
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, LIMIT);

  return NextResponse.json({ events });
}
