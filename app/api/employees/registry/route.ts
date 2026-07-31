import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { upsertRegistry } from '@/features/employees/engine/registry';
import { validateManualStartDate } from '@/features/employees/engine/tenure';

// Ручные поля реестра сотрудников: дата начала работы (стаж) + заметки.
// Пишем ТОЛЬКО в sa.employee_registry — sa.employees ведёт синк, её не трогаем.
export async function POST(req: Request) {
  const session = await getSession();
  const err = permError(session, 'section.employees');
  if (err) return err;

  let body: { bitrixId?: unknown; manualStartDate?: unknown; notes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const bitrixId = Number(body.bitrixId);
  if (!Number.isInteger(bitrixId) || bitrixId <= 0) {
    return NextResponse.json({ error: 'bitrixId обязателен' }, { status: 400 });
  }

  const patch: { manualStartDate?: string | null; notes?: string } = {};
  if ('manualStartDate' in body) {
    const v = body.manualStartDate;
    if (v !== null && typeof v !== 'string') {
      return NextResponse.json({ error: 'manualStartDate: строка ГГГГ-ММ-ДД или null' }, { status: 400 });
    }
    const value = v === null || v === '' ? null : (v as string);
    const invalid = validateManualStartDate(value);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    patch.manualStartDate = value;
  }
  if ('notes' in body) {
    if (typeof body.notes !== 'string') return NextResponse.json({ error: 'notes: строка' }, { status: 400 });
    patch.notes = body.notes.slice(0, 2000);
  }
  if (!('manualStartDate' in patch) && !('notes' in patch)) {
    return NextResponse.json({ error: 'Нет полей для сохранения' }, { status: 400 });
  }

  await upsertRegistry(bitrixId, patch, session!.login);
  return NextResponse.json({ ok: true });
}
