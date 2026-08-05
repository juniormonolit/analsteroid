import 'server-only';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { buildTeamRoster } from '@/features/manager-card/engine/teamCard';
import { computePeriodPlanByLogin } from '@/lib/plans/dailyPlan';
import { toZonedTime } from 'date-fns-tz';
import type { DateRange } from '@/lib/period';

// Тот же приём, что в features/manager-card/engine/planFact.ts: «сегодня» — по МСК,
// иначе после 21:00 по Москве серверный UTC-день уже следующий и план периода
// посчитается на день вперёд.
const TZ = 'Europe/Moscow';
function mskTodayStr(): string {
  return toZonedTime(new Date(), TZ).toISOString().slice(0, 10);
}

// «Мой отдел» глазами РЯДОВОГО менеджера (задача 3045, §3, новая разработка).
// Он видит коллег своего отдела: имя, фото, место в рейтинге и % выполнения ЛИЧНОГО
// плана — и НЕ видит абсолютных сумм и чужих сделок. Это осознанное ограничение
// спеки: «сколько заработал сосед» — не его дело, «кто где в таблице» — мотивирует.
//
// Абсолютные суммы всё же считаются на СЕРВЕРЕ (из них получается процент плана), но
// в ответ не попадают — фронту нечего фильтровать, он физически не получает денег.
//
// Рейтинг берётся тем же движком, что и ФИФА-сетка руководителя (buildTeamRoster) —
// иначе место в рейтинге у менеджера и у его РОПа разошлось бы на одних и тех же
// данных.

export interface PeerEntry {
  managerId: string;
  name: string;
  avatarUrl: string | null;
  /** Место в рейтинге отдела (1 — лучший). null, если рейтинг не посчитан. */
  place: number | null;
  /** Выполнение личного плана продаж за период, %. null — плана на период нет. */
  planPct: number | null;
  isMe: boolean;
}

export interface PeerRosterResult {
  mode: 'peer';
  departmentName: string | null;
  peers: PeerEntry[];
  /** Сколько коллег в отделе всего (включая себя) — для подписи «N человек». */
  totalPeers: number;
}

/** Отдел менеджера + активные коллеги того же отдела (один SQL, без N+1). */
async function loadOwnDeptPeers(bitrixUserId: string) {
  const db = analyticsDb();
  const res = await db.query<{
    manager_id: string; manager_name: string; short_login: string | null;
    department_id: string | null; department_name: string | null;
  }>(
    `WITH me AS (
       SELECT department_id
         FROM sa.org_resolved_hierarchy
        WHERE manager_bitrix_user_id::text = $1 AND is_active = true
        LIMIT 1
     )
     SELECT h.manager_bitrix_user_id::text AS manager_id, h.manager_name, h.short_login,
            h.department_id::text AS department_id, d.name AS department_name
       FROM sa.org_resolved_hierarchy h
       LEFT JOIN sa.departments d ON d.id = h.department_id
      WHERE h.is_active = true
        AND h.department_id IS NOT NULL
        AND h.department_id = (SELECT department_id FROM me)
      ORDER BY h.manager_name`,
    [bitrixUserId],
  );
  return res.rows;
}

export async function buildPeerRoster(opts: {
  bitrixUserId: string;
  period: DateRange;
}): Promise<PeerRosterResult> {
  const rows = await loadOwnDeptPeers(opts.bitrixUserId);
  if (rows.length === 0) {
    return { mode: 'peer', departmentName: null, peers: [], totalPeers: 0 };
  }

  const roster = rows.map(r => ({
    managerId: r.manager_id,
    name: r.manager_name,
    login: r.short_login,
    deptUuid: r.department_id ?? '',
  }));

  const fromStr = opts.period.from.toISOString().slice(0, 10);
  const toStr = opts.period.to.toISOString().slice(0, 10);

  const [team, plans, avatars] = await Promise.all([
    buildTeamRoster({ roster, period: opts.period, segment: 'all' }),
    computePeriodPlanByLogin(fromStr, toStr, mskTodayStr()),
    // Фото — из users (системная БД) по bitrix_user_id: в оргструктуре аватарок нет.
    systemDb().query<{ bitrix_user_id: string; avatar_url: string | null }>(
      `SELECT bitrix_user_id, avatar_url FROM users
        WHERE bitrix_user_id = ANY($1) AND avatar_url IS NOT NULL`,
      [roster.map(r => r.managerId)],
    ),
  ]);

  const avatarById = new Map(avatars.rows.map(r => [r.bitrix_user_id, r.avatar_url]));

  // Место в рейтинге: по убыванию rating; без рейтинга — в конец без места.
  const ranked = [...team.managers]
    .filter(m => m.rating !== null)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const placeById = new Map(ranked.map((m, i) => [m.managerId, i + 1]));

  const peers: PeerEntry[] = team.managers.map(m => {
    const plan = m.login ? plans.byLogin.get(m.login) : undefined;
    const planPct = plan && plan.planSales > 0 ? Math.round((m.salesAmount / plan.planSales) * 100) : null;
    return {
      managerId: m.managerId,
      name: m.name,
      avatarUrl: avatarById.get(m.managerId) ?? null,
      place: placeById.get(m.managerId) ?? null,
      planPct,
      isMe: m.managerId === opts.bitrixUserId,
    };
  });

  // Сортировка выдачи — по месту (свой всегда виден там, где он есть на самом деле,
  // без «подтягивания наверх»: это таблица отдела, а не персональная витрина).
  peers.sort((a, b) => (a.place ?? 1e9) - (b.place ?? 1e9) || a.name.localeCompare(b.name, 'ru'));

  return {
    mode: 'peer',
    departmentName: rows[0].department_name ?? null,
    peers,
    totalPeers: peers.length,
  };
}
