import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { detectRenames, getEmployeesList } from '@/features/employees/engine/registry';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { canSeeManager, getSessionScope } from '@/lib/org/sessionScope';

// Реестр сотрудников (задача 2654): список + запуск детекта переименований
// (in-memory кэш ~6 ч внутри detectRenames — при обращении к странице).
//
// canOpenCabinet (задача 2771, «список менеджеров и РОПов для админа» — Серёга
// зашёл с телефона, увидел пустой ЛК, попросил список с переходом в чужой ЛК):
// раздел «Сотрудники» может быть выдан ролям шире, чем админ/директор (право
// section.employees настраивается отдельно) — переход в чужой ЛК из списка
// нужен строго админу/директору+, поэтому флаг считается отдельно от гейта
// самого списка и решение показывать ли колонку «Открыть ЛК» — на клиенте по
// этому флагу, а не по факту наличия section.employees.
//
// Аудит 09.09 («Главные дыры» п.4): носитель section.employees получал весь
// реестр компании. Теперь строки — только по менеджерам среза сессии
// (админ — все), форма ответа прежняя.
export async function GET() {
  const session = await getSession();
  const err = permError(session, 'section.employees');
  if (err) return err;

  let detect = null;
  try {
    detect = await detectRenames();
  } catch (e) {
    // Детект не должен ронять страницу — список показываем в любом случае.
    console.error('[employees] детект переименований упал:', e);
  }
  const [allRows, scope] = await Promise.all([getEmployeesList(), getSessionScope(session!)]);
  const rows = allRows.filter(r => canSeeManager(scope, String(r.bitrixId)));
  return NextResponse.json({ rows, detect, canOpenCabinet: hasFullManagerAccess(session!) });
}
