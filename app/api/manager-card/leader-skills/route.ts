import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { buildLeaderSkills } from '@/features/manager-card/engine/leaderSkills';

// Скиллы руководителя (решение владельца 05.08). Область считает СЕРВЕР:
//   • без параметров — свои отделы по оргструктуре «Контроля звонков»
//     (правило высшей позиции уже внутри: РОП∧директор = директор);
//   • ?bitrixId= — чужие: показываем скиллы того руководителя, чей публичный
//     профиль открыт. Это публичные показатели ОТДЕЛА в относительной шкале
//     (перцентиль), без сумм по конкретным людям — тот же уровень открытости,
//     что у остального публичного профиля.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const requested = req.nextUrl.searchParams.get('bitrixId');
  const target = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!target) return NextResponse.json({ skills: null });

  const managed = await getCallControlManagedDepts(target);
  let deptIds = managed.map(m => m.deptId);

  // Свой запрос без bitrixId: у админа/директора без назначенных отделов
  // подхватываем всё, что ему доступно (иначе у руководства скиллов не будет).
  if (deptIds.length === 0 && target === session.bitrixUserId) {
    deptIds = hasFullManagerAccess(session) ? [] : await managedDepartmentIds(session);
  }
  if (deptIds.length === 0) return NextResponse.json({ skills: null });

  const skills = await buildLeaderSkills(deptIds);
  return NextResponse.json({ skills });
}
