// POST /api/my-report — данные для конструктора отчётов «Мой отчёт».
// Вся сборка — в lib/reports-builder/buildMyReport.ts (общая с авторассылкой
// шаблонов ботом, задача 09.09); здесь только HTTP: сессия, JSON, статусы.
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildMyReportSpec, MyReportInputError, EntityAccessError } from '@/lib/reports-builder/buildMyReport';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    return NextResponse.json(await buildMyReportSpec(session, body));
  } catch (err) {
    if (err instanceof MyReportInputError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof EntityAccessError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
}
