// Раздел «Рейтинг» (задача владельца 30.07) — рейтинг менеджеров за период с
// баллами по осям шаблона карточки. Считает тот же движок, что ЛК менеджера
// (features/manager-card/engine/ratings.ts), поэтому цифры не расходятся.
//
// Доступ — та же модель, что у карточек (lib/org/managerAccess.ts): руководство
// видит всех, РОП — своих, остальные — только себя. Место в общем рейтинге (ранг)
// при этом считается по ПОЛНОМУ пулу — «#7 из 130» честно, даже если в таблице
// пользователю видно только его строку.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { branchLabel } from '@/lib/org/branchLabel';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { computeManagerRatings } from '@/features/manager-card/engine/ratings';
import type { CardSegment } from '@/features/manager-card/engine/managerCard';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (!body.period?.from || !body.period?.to) {
    return NextResponse.json({ error: 'period.from/period.to обязательны' }, { status: 400 });
  }
  const period = { from: new Date(body.period.from), to: new Date(body.period.to) };
  const segment: CardSegment = ['all', 'fl', 'ul'].includes(body.segment) ? body.segment : 'all';
  const templateKey = body.templateKey === 'department' ? 'department' as const : 'manager' as const;

  try {
    const [{ byManager, axes, poolSize }, orgRes] = await Promise.all([
      computeManagerRatings({ period, segment, templateKey }),
      analyticsDb().query<{ manager_id: string; name: string; login: string | null; department: string | null; branch: string | null; department_id: string | null }>(
        `SELECT manager_bitrix_user_id::text AS manager_id, manager_name AS name, short_login AS login,
                department_name AS department, branch, department_id::text AS department_id
           FROM sa.org_resolved_hierarchy WHERE is_active = true`,
      ),
    ]);
    const orgById = new Map(orgRes.rows.map(r => [r.manager_id, r]));

    // Полный отсортированный список — ранги считаются здесь, ДО фильтра доступа.
    const ranked = [...byManager.values()]
      .filter(r => r.rating !== null)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    const rankById = new Map(ranked.map((r, i) => [r.managerId, i + 1]));

    // Кого пользователю видно
    let visible: Set<string> | null = null; // null = всех
    if (!hasFullManagerAccess(session)) {
      const deptIds = await managedDepartmentIds(session);
      const roster = deptIds.length > 0 ? await resolveManagersForDepartments(deptIds) : [];
      visible = new Set(roster.map(m => m.managerId));
      if (session.bitrixUserId) visible.add(session.bitrixUserId);
    }

    const rows = ranked
      .filter(r => visible === null || visible.has(r.managerId))
      .map(r => {
        const org = orgById.get(r.managerId);
        return {
          managerId: r.managerId,
          name: org?.name ?? `#${r.managerId}`,
          login: org?.login ?? null,
          department: org?.department ?? null,
          branch: branchLabel(org?.branch ?? null) || null,
          rating: r.rating,
          rank: rankById.get(r.managerId) ?? null,
          isSelf: session.bitrixUserId === r.managerId,
          axes: r.axes.map(a => ({ key: a.key, label: a.label, score: a.score, raw: a.raw, weight: a.weight })),
        };
      });

    return NextResponse.json({
      rows,
      total: ranked.length,
      poolSize,
      axes: axes.map(a => ({ key: a.key, label: a.label, weight: a.weight, invert: a.invert, unit: a.unit })),
      scopeLimited: visible !== null,
    });
  } catch (e) {
    console.error('[rating] failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта рейтинга' }, { status: 500 });
  }
}
