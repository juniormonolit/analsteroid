import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { detectRenames, getEmployeesList } from '@/features/employees/engine/registry';

// Реестр сотрудников (задача 2654): список + запуск детекта переименований
// (in-memory кэш ~6 ч внутри detectRenames — при обращении к странице).
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
  const rows = await getEmployeesList();
  return NextResponse.json({ rows, detect });
}
