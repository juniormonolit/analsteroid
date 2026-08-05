import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildPeerRoster } from '@/features/profile/engine/peerRoster';
import { defaultPeriod } from '@/lib/period';

// «Мой отдел» глазами рядового менеджера (задача 3045, §3). Охват определяет СЕРВЕР по
// сессии: отдел берётся из оргструктуры по bitrix_user_id сессии, никаких id из запроса —
// подставить чужой отдел в параметрах нельзя физически.
//
// Отступление от §3 спеки, осознанное: спека просит ОДИН эндпоинт на оба вида «Моего
// отдела» (руководителя и менеджера). Здесь только вид менеджера, а вид руководителя
// остался на своём рабочем POST /api/manager-card/team. Причина: требование спеки —
// «фронт не выбирает режим», и оно выполнено, но выбор делает не эндпоинт, а серверная
// страница /profile/team (она и так серверная — считает canViewDepartmentData и рендерит
// нужный вид). Переписывать работающую ФИФА-сетку руководителя с её селекторами
// периода/сегмента/отдела на новый контракт — риск регресса без выигрыша.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!session.bitrixUserId) {
    return NextResponse.json({ error: 'Аккаунт не связан с Битриксом' }, { status: 409 });
  }

  // Период: 'month' (дефолт) — текущий месяц, как в остальных экранах карточки;
  // 'all' — вся история, тот же смысл, что у переключателя ФИФА-сетки руководителя.
  const scope = req.nextUrl.searchParams.get('period') === 'all' ? 'all' : 'month';
  const period = scope === 'all'
    ? { from: new Date('2015-01-01T00:00:00Z'), to: new Date() }
    : defaultPeriod();

  const result = await buildPeerRoster({ bitrixUserId: session.bitrixUserId, period });
  return NextResponse.json(result);
}
