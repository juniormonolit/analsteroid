import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { fromZonedTime } from 'date-fns-tz';

// «Движуха» (задача владельца 05.08): общая новостная лента компании — все
// продажи «обычными комментариями», гип-посты по порогам сделки (3/5/10/20 млн),
// награды и выполненные квесты всех менеджеров, закреплённый топ-3 продаж дня
// (отсечка 18:00, награда в конце дня — существующие бейджи «Топ продаж»).
// Хранимой ленты нет — собирается на лету, как персональная (/api/profile/feed).
// Доступ — любой залогиненный. ?scope=dept — только отдел зрителя (по оргструктуре).

const LIMIT = 80;          // событий в ответе после слияния
const SALES_SCAN = 120;    // свежих продаж со сдвига (все, вкл. «комментарии»)
const SIDE_LIMIT = 40;     // наград/квестов до слияния

export interface PulseEvent {
  type: 'sale' | 'badge' | 'quest';
  ts: string;
  managerId: string;
  managerName: string;
  department: string | null;
  title: string;           // sale: имя сделки; badge: название; quest: заголовок
  emoji: string;
  tier: string | null;
  amount: number | null;
  subtitle: string | null; // sale: головная группа; quest: награда
  /** Градация ликования для продаж: plain <3млн, notable ≥3, big ≥5, mega ≥10, insane ≥20. */
  hype: 'plain' | 'notable' | 'big' | 'mega' | 'insane' | null;
}

function hypeFor(amount: number): PulseEvent['hype'] {
  if (amount >= 20_000_000) return 'insane';
  if (amount >= 10_000_000) return 'mega';
  if (amount >= 5_000_000) return 'big';
  if (amount >= 3_000_000) return 'notable';
  return 'plain';
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const scope = req.nextUrl.searchParams.get('scope') === 'dept' ? 'dept' : 'company';

  // Справочник менеджеров: имя/отдел (+ отдел зрителя для scope=dept).
  const org = await analyticsDb().query<{ id: string; name: string; department: string | null; department_id: string | null }>(
    `SELECT DISTINCT ON (h.manager_bitrix_user_id)
            h.manager_bitrix_user_id::text AS id, h.manager_name AS name,
            d.name AS department, h.department_id::text AS department_id
       FROM sa.org_resolved_hierarchy h
       LEFT JOIN sa.departments d ON d.id = h.department_id
      WHERE h.is_active = true AND h.manager_bitrix_user_id IS NOT NULL
      ORDER BY h.manager_bitrix_user_id, h.manager_name`,
  );
  const byId = new Map(org.rows.map(r => [r.id, r]));
  const viewerDeptId = session.bitrixUserId ? (byId.get(session.bitrixUserId)?.department_id ?? null) : null;
  const deptIds = scope === 'dept' && viewerDeptId
    ? new Set(org.rows.filter(r => r.department_id === viewerDeptId).map(r => r.id))
    : null; // null = вся компания

  const inScope = (managerId: string) => !deptIds || deptIds.has(managerId);

  // Начало текущего дня МСК — для закреплённого топ-3.
  const now = new Date();
  const mskDay = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }); // YYYY-MM-DD
  const dayStartUtc = fromZonedTime(`${mskDay}T00:00:00`, 'Europe/Moscow').toISOString();

  const [sales, badges, quests, top3] = await Promise.all([
    analyticsDb().query<{ ts: string; deal_name: string; amount: string; head_group_name: string | null; manager_id: string }>(
      `SELECT sold_at AS ts, deal_name, amount::text, head_group_name, current_manager_id::text AS manager_id
         FROM sa.deals
        WHERE sold_at IS NOT NULL AND amount > 0
        ORDER BY sold_at DESC
        LIMIT $1`,
      [SALES_SCAN],
    ).catch(() => ({ rows: [] as { ts: string; deal_name: string; amount: string; head_group_name: string | null; manager_id: string }[] })),
    systemDb().query<{ ts: string; name: string; icon: string; tier: string | null; bitrix_id: number }>(
      `SELECT a.awarded_at AS ts, d.name, d.icon, a.tier, a.bitrix_id
         FROM badge_awards a
         JOIN badge_definitions d ON d.key = a.badge_key
        WHERE a.badge_key <> 'xp_first_group'
        ORDER BY a.awarded_at DESC
        LIMIT $1`,
      [SIDE_LIMIT],
    ).catch(() => ({ rows: [] as { ts: string; name: string; icon: string; tier: string | null; bitrix_id: number }[] })),
    systemDb().query<{ ts: string; title: string; tier: string; reward_eballs: number; reward_xp: number; bitrix_id: string }>(
      `SELECT done_at AS ts, title, tier, reward_eballs, reward_xp, bitrix_id::text AS bitrix_id
         FROM quests
        WHERE status = 'done' AND done_at IS NOT NULL
        ORDER BY done_at DESC
        LIMIT $1`,
      [SIDE_LIMIT],
    ).catch(() => ({ rows: [] as { ts: string; title: string; tier: string; reward_eballs: number; reward_xp: number; bitrix_id: string }[] })),
    analyticsDb().query<{ ts: string; deal_name: string; amount: string; head_group_name: string | null; manager_id: string }>(
      `SELECT sold_at AS ts, deal_name, amount::text, head_group_name, current_manager_id::text AS manager_id
         FROM sa.deals
        WHERE sold_at >= $1 AND amount > 0
        ORDER BY amount DESC
        LIMIT 10`,
      [dayStartUtc],
    ).catch(() => ({ rows: [] as { ts: string; deal_name: string; amount: string; head_group_name: string | null; manager_id: string }[] })),
  ]);

  const toSale = (r: typeof sales.rows[number]): PulseEvent | null => {
    const who = byId.get(r.manager_id);
    if (!who || !inScope(r.manager_id)) return null;
    const amount = Math.round(Number(r.amount));
    return {
      type: 'sale', ts: r.ts, managerId: r.manager_id, managerName: who.name,
      department: who.department, title: r.deal_name, emoji: '💰', tier: null,
      amount, subtitle: r.head_group_name, hype: hypeFor(amount),
    };
  };

  const events: PulseEvent[] = [
    ...sales.rows.map(toSale).filter((e): e is PulseEvent => e !== null),
    ...badges.rows.flatMap((r): PulseEvent[] => {
      const id = String(r.bitrix_id);
      const who = byId.get(id);
      if (!who || !inScope(id)) return [];
      return [{
        type: 'badge', ts: r.ts, managerId: id, managerName: who.name, department: who.department,
        title: r.name, emoji: r.icon || '🏅', tier: r.tier, amount: null, subtitle: null, hype: null,
      }];
    }),
    ...quests.rows.flatMap((r): PulseEvent[] => {
      const who = byId.get(r.bitrix_id);
      if (!who || !inScope(r.bitrix_id)) return [];
      return [{
        type: 'quest', ts: r.ts, managerId: r.bitrix_id, managerName: who.name, department: who.department,
        title: r.title, emoji: '⚔️', tier: r.tier, amount: null,
        subtitle: [r.reward_eballs ? `+${r.reward_eballs} MLT` : null, r.reward_xp ? `+${r.reward_xp} XP` : null].filter(Boolean).join(' · ') || null,
        hype: null,
      }];
    }),
  ]
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, LIMIT);

  const topToday = top3.rows.map(toSale).filter((e): e is PulseEvent => e !== null).slice(0, 3);

  return NextResponse.json({ events, topToday, scope, hasDept: !!viewerDeptId });
}
