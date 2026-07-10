import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { buildDepartmentCard } from '@/features/manager-card/engine/teamCard';
import type { CardSegment } from '@/features/manager-card/engine/managerCard';
import {
  getUserDepartmentOptions, getRootDepartmentOptions, resolveManagersForDepartments,
  getAllManagedDepartmentIds, bucketManagersByDepartments,
} from '@/lib/org/teamRoster';
import { branchLabel } from '@/lib/org/branchLabel';

// «Карточка отдела» (карточка менеджера v2, бриф 10.07, п.3) — та же форма, что
// карточка одного менеджера (ManagerCardPanel переиспользуется на клиенте один в
// один — см. features/manager-card/ui/ManagerCardPanel.tsx, проп mode="department"),
// но посчитанная агрегатом по отделу («виртуальный менеджер», см. teamCard.ts).
//
// Доступ — та же граница, что /api/manager-card/team (РОП/Директор/Администратор/
// супер-админ); departmentId — тот же селектор, включая синтетический 'all'
// (объединение всех назначенных отделов пользователя). Для 'all' сравнение с
// пирами не считаем осмысленным (это не единый узел дерева) — честный прочерк
// (peerCount=1, insufficientPeers=true).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const allowedRole = session.isSuperadmin
    || session.roleName === 'Директор'
    || session.roleName === 'Администратор'
    || session.roleName === 'РОП';
  if (!allowedRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const { period, segment = 'all' as CardSegment, departmentId } = body;
  if (!period?.from || !period?.to) {
    return NextResponse.json({ error: 'period.from/period.to обязательны' }, { status: 400 });
  }
  if (!departmentId) return NextResponse.json({ error: 'departmentId обязателен' }, { status: 400 });

  let options = await getUserDepartmentOptions(session.id);
  const isElevated = session.isSuperadmin || session.roleName === 'Директор' || session.roleName === 'Администратор';
  if (options.length === 0 && isElevated) options = await getRootDepartmentOptions();
  const optionIds = new Set(options.map(o => o.id));

  const periodRange = { from: new Date(period.from), to: new Date(period.to) };
  const start = Date.now();

  // Живой смок деплоя 44: на отделах >5 менеджеров buildDepartmentCard валился
  // необработанным исключением (N+1 fetchByProductGroups по менеджеру упирался в
  // connectionTimeoutMillis пула analyticsDb) → голый 500. N+1 убран (см. teamCard.ts),
  // но на случай ЛЮБОЙ другой неожиданной ошибки агрегата отдаём внятный 502, а не
  // бессодержательный 500.
  try {
    if (departmentId === 'all') {
      if (options.length === 0) return NextResponse.json({ error: 'Отделы не назначены' }, { status: 403 });
      const roster = await resolveManagersForDepartments(options.map(o => o.id));
      const result = await buildDepartmentCard({
        deptId: 'all', deptName: `Все отделы (${options.length})`, branch: null,
        roster,
        peerBuckets: new Map([['all', roster]]), // сравнивать не с кем — честный прочерк
        period: periodRange, segment,
      });
      return NextResponse.json({ ...result, meta: { ...result.meta, durationMs: Date.now() - start } });
    }

    if (!optionIds.has(departmentId)) return NextResponse.json({ error: 'Отдел недоступен' }, { status: 403 });

    const [roster, peerOptions, branchRow] = await Promise.all([
      resolveManagersForDepartments([departmentId]),
      getAllManagedDepartmentIds(),
      systemDb().query<{ branch: string | null }>(
        `SELECT branch FROM org_resolved_hierarchy
          WHERE department_id = $1 AND is_active = true LIMIT 1`,
        [departmentId],
      ),
    ]);

    const peerIds = [...new Set([departmentId, ...peerOptions.map(o => o.id)])];
    const peerBuckets = await bucketManagersByDepartments(peerIds);

    const deptName = options.find(o => o.id === departmentId)?.name
      ?? peerOptions.find(o => o.id === departmentId)?.name
      ?? '—';

    const result = await buildDepartmentCard({
      deptId: departmentId, deptName, branch: branchLabel(branchRow.rows[0]?.branch ?? null) || null,
      roster, peerBuckets,
      period: periodRange, segment,
    });

    return NextResponse.json({ ...result, meta: { ...result.meta, durationMs: Date.now() - start } });
  } catch (err) {
    console.error('[department-card] build failed', { departmentId, error: err instanceof Error ? err.message : err });
    return NextResponse.json({ error: 'Не удалось построить карточку отдела' }, { status: 502 });
  }
}
