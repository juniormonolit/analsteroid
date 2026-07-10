import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildTeamRoster } from '@/features/manager-card/engine/teamCard';
import type { CardSegment } from '@/features/manager-card/engine/managerCard';
import {
  getUserDepartmentOptions, getRootDepartmentOptions, resolveManagersForDepartments,
} from '@/lib/org/teamRoster';

// ФИФА-сетка «Мой отдел» (карточка менеджера v2, бриф 10.07, п.1). Видимость —
// РЕШЕНИЕ (см. отчёт задачи): роли РОП/Директор/Администратор + супер-админ.
// «Пользователь»/«МОП» — 403 (в UI блок вообще не рендерится, это второй рубеж).
//
// Отделы селектора — «Руководит» (user_departments) текущего пользователя; если
// назначений нет, а роль/флаг это позволяет (Директор/Администратор/супер-админ) —
// фолбэк на корневые узлы дерева departments (чтобы селектор не был пуст даже без
// ручных назначений). РОП без назначений видит пустой блок («Отделы не
// назначены») — как и в ЛК-сводке /api/me/dept-summary.
//
// Дефолт селекции (РЕШЕНИЕ, п.1 брифа «дефолт — все отделы юзера / первый»):
// 'all' (объединение ВСЕХ назначенных отделов), если назначено больше одного;
// единственный отдел — если назначен один. Явный departmentId в body переопределяет.
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
  if (!['all', 'fl', 'ul'].includes(segment)) {
    return NextResponse.json({ error: 'segment должен быть all/fl/ul' }, { status: 400 });
  }

  let options = await getUserDepartmentOptions(session.id);
  const isElevated = session.isSuperadmin || session.roleName === 'Директор' || session.roleName === 'Администратор';
  if (options.length === 0 && isElevated) {
    options = await getRootDepartmentOptions();
  }
  if (options.length === 0) {
    return NextResponse.json({
      departmentOptions: [], selectedDepartmentId: null, departmentName: null,
      managers: [], totalManagers: 0,
      meta: { period: { from: period.from, to: period.to } },
    });
  }

  const optionIds = new Set(options.map(o => o.id));
  let selection: string;
  if (departmentId && departmentId !== 'all') {
    if (!optionIds.has(departmentId)) return NextResponse.json({ error: 'Отдел недоступен' }, { status: 403 });
    selection = departmentId;
  } else if (departmentId === 'all' || options.length > 1) {
    selection = 'all';
  } else {
    selection = options[0].id;
  }

  const resolveIds = selection === 'all' ? options.map(o => o.id) : [selection];
  const departmentName = selection === 'all'
    ? `Все отделы (${options.length})`
    : (options.find(o => o.id === selection)?.name ?? '—');

  const roster = await resolveManagersForDepartments(resolveIds);
  const start = Date.now();
  const result = await buildTeamRoster({
    roster,
    period: { from: new Date(period.from), to: new Date(period.to) },
    segment,
  });

  const managers = result.managers.map((m, i) => ({ ...m, isTop1: i === 0 && m.rating !== null }));

  return NextResponse.json({
    departmentOptions: options,
    selectedDepartmentId: selection,
    departmentName,
    managers,
    totalManagers: managers.length,
    meta: { ...result.meta, durationMs: Date.now() - start },
  });
}
