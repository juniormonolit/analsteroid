import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';
import {
  getMonthlyEmission, getPrevMonthlyEmission, getMonthlyAbsorption,
  getCirculation, getBalanceRows, getRubEconomics,
} from '@/features/badges/engine/dashboard';
import { getExpiringSoonTotal } from '@/features/badges/engine/wallet';
import { getXpDashboard } from '@/features/badges/engine/xpDashboard';

// «Геймификация → Дашборд» (задача 2741 + 2745 «ещё и по опыту»): сводка
// экономики ебаллов/рублей (балансы, эмиссия/поглощение, здоровье экономики —
// owners-inbox/monolitika-sink-mechanics.md) + сводка/список по XP-системе
// (features/xp/engine/xp.ts). Тот же гейт, что у остальных /settings/badges/*
// — только супер-админ.
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  const db = systemDb();
  const [
    currencyName, emission, prevEmission, { abs: absorption, freeSinkAmount },
    circulation, toBurn30d, balanceRows, orgRes, xp, rubEconomics,
  ] = await Promise.all([
    getCurrencyName(db),
    getMonthlyEmission(db),
    getPrevMonthlyEmission(db),
    getMonthlyAbsorption(db),
    getCirculation(db),
    getExpiringSoonTotal(db, 30),
    getBalanceRows(db),
    analyticsDb().query<{ manager_id: string; name: string; login: string | null; department: string | null }>(
      `SELECT manager_bitrix_user_id::text AS manager_id, manager_name AS name, short_login AS login,
              department_name AS department
         FROM sa.org_resolved_hierarchy WHERE is_active = true`,
    ),
    getXpDashboard(db),
    // Рублёвая смета (правка владельца 05.08): фактическая стоимость геймификации.
    getRubEconomics(db),
  ]);

  const orgById = new Map(orgRes.rows.map(r => [r.manager_id, r]));
  const byBitrixId = new Map(balanceRows.map(r => [r.bitrixId, r]));
  // Полный ростер активных менеджеров: у кого нет строк в леджере — нули
  // (видно, что «ещё не начали получать ебаллы», а не пропали из таблицы).
  const allIds = new Set<number>([...byBitrixId.keys(), ...orgRes.rows.map(r => Number(r.manager_id)).filter(Number.isInteger)]);
  const balances = [...allIds].map(id => {
    const b = byBitrixId.get(id);
    const org = orgById.get(String(id));
    return {
      bitrixId: id,
      name: org?.name ?? `#${id}`,
      department: org?.department ?? null,
      eball: b?.eball ?? 0,
      rub: b?.rub ?? 0,
      earned30: b?.earned30 ?? 0,
      spent30: b?.spent30 ?? 0,
    };
  }).sort((a, b) => b.eball - a.eball);

  const emissionMomPct = prevEmission.total > 0
    ? Math.round(((emission.total - prevEmission.total) / prevEmission.total) * 1000) / 10
    : null;
  const freeSinkShare = emission.total > 0 ? freeSinkAmount / emission.total : null;

  // XP-список (задача 2745): те же имя/отдел из оргструктуры, что у балансов
  // выше; сотрудников без единой XP-строки НЕ добавляем нулями — таблица «по
  // опыту» показывает только тех, у кого вообще есть прогресс (иначе список
  // на 430 строк с сотнями нулей, менее полезно, чем балансы валюты).
  const xpRows = xp.rows.map(r => {
    const org = orgById.get(String(r.bitrixId));
    return { ...r, name: org?.name ?? `#${r.bitrixId}`, department: org?.department ?? null };
  }).sort((a, b) => b.totalXp - a.totalXp);

  return NextResponse.json({
    rubEconomics,
    currencyName,
    balances,
    emission,
    prevEmissionTotal: prevEmission.total,
    emissionMomPct,
    absorption,
    health: {
      emission: emission.total,
      absorption: absorption.total,
      freeSinkAmount,
      freeSinkShare,
      toBurn30d,
    },
    circulation,
    xp: { summary: xp.summary, rows: xpRows },
  });
}
